import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, CartStatus, ProductStatus, ProductVariantStatus, CheckoutStatus } from '@prisma/client';
import { CheckoutService } from '../src/checkout/checkout.service.js';
import { FeaturesService } from '../src/features/features.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { UserRole } from '@vishkaraa/types';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Checkout Concurrency & Cart Safety — Physical PostgreSQL Integration', () => {
  // Use test database URL from environment or .env
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:password@localhost:5432/vishkaraa_test?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let checkoutService: CheckoutService;
  let testUser: MinimalUser;
  let createdUserId: string;
  let createdProductId: string;
  let createdVariantId: string;
  let createdCartId: string;

  beforeAll(async () => {
    await prisma.$connect();

    // Mock features service to always enable CHECKOUT
    const mockFeaturesService = {
      isFeatureEnabled: async () => true,
    } as unknown as FeaturesService;

    // Mock audit service to avoid cluttering audit logs
    const mockAuditService = {
      logEvent: async () => {},
    } as unknown as AuditService;

    checkoutService = new CheckoutService(
      prisma as any,
      mockFeaturesService,
      mockAuditService,
    );

    // 1. Create isolated test user
    const user = await prisma.user.create({
      data: {
        email: `concurrency-test-${Date.now()}@vishkaraa.local`,
        passwordHash: 'argon2-dummy-hash',
        firstName: 'Concurrency',
        lastName: 'Tester',
        role: 'USER',
      },
    });
    createdUserId = user.id;
    testUser = {
      id: user.id,
      role: UserRole.USER,
      email: user.email,
    };

    // 2. Create test product & variant
    const product = await prisma.product.create({
      data: {
        name: `Concur Product ${Date.now()}`,
        slug: `concur-prod-${Date.now()}`,
        status: ProductStatus.ACTIVE,
        category: {
          create: {
            name: `Concur Category ${Date.now()}`,
            slug: `concur-cat-${Date.now()}`,
            status: 'ACTIVE',
          },
        },
      },
    });
    createdProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: '500ml Jar',
        sku: `CONCUR-SKU-${Date.now()}`,
        price: 35000, // 350 INR
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    createdVariantId = variant.id;

    // 3. Create active cart with item
    const cart = await prisma.cart.create({
      data: {
        userId: user.id,
        status: CartStatus.ACTIVE,
        currency: 'INR',
        items: {
          create: {
            productId: product.id,
            productVariantId: variant.id,
            quantity: 2,
            unitPrice: 35000,
            currency: 'INR',
          },
        },
      },
    });
    createdCartId = cart.id;
  });

  afterAll(async () => {
    // Clean up test records
    try {
      await prisma.checkoutItemSnapshot.deleteMany({
        where: { productVariantId: createdVariantId },
      });
      await prisma.checkoutSession.deleteMany({
        where: { userId: createdUserId },
      });
      await prisma.cartItem.deleteMany({
        where: { cartId: createdCartId },
      });
      await prisma.cart.deleteMany({
        where: { id: createdCartId },
      });
      await prisma.productVariant.deleteMany({
        where: { id: createdVariantId },
      });
      await prisma.product.deleteMany({
        where: { id: createdProductId },
      });
      await prisma.user.deleteMany({
        where: { id: createdUserId },
      });
    } catch {
      // Best-effort cleanup
    } finally {
      await prisma.$disconnect();
    }
  });

  it('guarantees exactly ONE active checkout session during concurrent initialization requests', async () => {
    // Fire 5 concurrent checkout initialization requests simultaneously against real PostgreSQL
    const concurrentRequests = Array.from({ length: 5 }, () =>
      checkoutService.initializeCheckout(testUser),
    );

    const results = await Promise.all(concurrentRequests);

    // 1. All concurrent requests should succeed without crashing or throwing unhandled errors
    expect(results).toHaveLength(5);
    for (const res of results) {
      expect(res.status).toBe(CheckoutStatus.ACTIVE);
      expect(res.subtotal).toBe(70000); // 2 * 35000
    }

    // 2. All 5 requests must have returned the exact same session ID
    const firstSessionId = results[0]!.id;
    for (const res of results) {
      expect(res.id).toBe(firstSessionId);
    }

    // 3. Directly query PostgreSQL to verify the partial unique index invariant:
    // Exactly ONE active checkout session exists in the database for this user/cart
    const activeSessionsInDb = await prisma.checkoutSession.findMany({
      where: {
        userId: testUser.id,
        cartId: createdCartId,
        status: CheckoutStatus.ACTIVE,
      },
    });

    expect(activeSessionsInDb).toHaveLength(1);
    expect(activeSessionsInDb[0]!.id).toBe(firstSessionId);
  });

  it('preserves historical checkout sessions and snapshots when the operational cart is deleted (ON DELETE SET NULL)', async () => {
    // 1. Get the current active session
    const activeSession = await prisma.checkoutSession.findFirst({
      where: {
        userId: testUser.id,
        cartId: createdCartId,
        status: CheckoutStatus.ACTIVE,
      },
    });
    expect(activeSession).toBeDefined();

    // 2. Delete the operational cart (simulating administrative/retention cleanup)
    await prisma.cart.delete({
      where: { id: createdCartId },
    });

    // 3. Verify the CheckoutSession row was NOT deleted by cascade
    const preservedSession = await prisma.checkoutSession.findUnique({
      where: { id: activeSession!.id },
      include: { items: true },
    });

    expect(preservedSession).toBeDefined();
    expect(preservedSession!.id).toBe(activeSession!.id);
    // cartId must be set to null by ON DELETE SET NULL
    expect(preservedSession!.cartId).toBeNull();
    // Items snapshot must remain completely intact as immutable financial record
    expect(preservedSession!.items).toHaveLength(1);
    expect(preservedSession!.items[0]!.productVariantId).toBe(createdVariantId);
    expect(preservedSession!.items[0]!.unitPrice).toBe(35000);
  });
});
