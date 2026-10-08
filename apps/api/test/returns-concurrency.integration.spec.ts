import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  CartStatus,
  ProductStatus,
  ProductVariantStatus,
  CheckoutStatus,
  PaymentStatus,
  OrderStatus,
  ReturnStatus,
  ReturnReason,
} from '@prisma/client';
import { ReturnService } from '../src/returns/return.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { UserRole } from '@vishkaraa/types';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Returns Concurrency & Row-Locking Safety — Physical PostgreSQL Integration', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_test?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let returnService: ReturnService;
  let testUser: MinimalUser;
  let createdUserId: string;
  let createdProductId: string;
  let createdVariantId: string;
  let createdCartId: string;
  let createdSessionId: string;
  let createdAttemptId: string;
  let createdOrderId: string;
  let createdOrderItemId: string;

  beforeAll(async () => {
    await prisma.$connect();

    // Mock audit service to keep test clean
    const mockAuditService = {
      log: async () => {},
    } as unknown as AuditService;

    // ReturnService with real PrismaClient pointing to test PostgreSQL
    returnService = new ReturnService(
      prisma as any,
      mockAuditService,
    );

    const timestamp = Date.now();

    // 1. Create test user
    const user = await prisma.user.create({
      data: {
        email: `return-concur-${timestamp}@vishkaraa.local`,
        passwordHash: 'argon2-dummy-hash',
        firstName: 'Return',
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

    // 2. Create test product & variant (isReturnable: true)
    const product = await prisma.product.create({
      data: {
        name: `Concur Return Product ${timestamp}`,
        slug: `concur-ret-prod-${timestamp}`,
        status: ProductStatus.ACTIVE,
        isReturnable: true,
        category: {
          create: {
            name: `Concur Return Cat ${timestamp}`,
            slug: `concur-ret-cat-${timestamp}`,
            status: 'ACTIVE',
          },
        },
      },
    });
    createdProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: 'Standard Unit',
        sku: `CONCUR-RET-SKU-${timestamp}`,
        price: 50000, // 500 INR
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    createdVariantId = variant.id;

    // 3. Create active cart
    const cart = await prisma.cart.create({
      data: {
        userId: user.id,
        status: CartStatus.ACTIVE,
        currency: 'INR',
      },
    });
    createdCartId = cart.id;

    // 4. Create checkout session
    const session = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        cartId: cart.id,
        status: CheckoutStatus.COMPLETED,
        subtotal: 50000,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 3600 * 1000),
      },
    });
    createdSessionId = session.id;

    // 5. Create payment attempt (CAPTURED)
    const attempt = await prisma.paymentAttempt.create({
      data: {
        userId: user.id,
        checkoutSessionId: session.id,
        amount: 50000,
        currency: 'INR',
        status: PaymentStatus.CAPTURED,
        provider: 'MOCK',
        providerOrderId: `order_mock_${timestamp}`,
        providerPaymentId: `pay_mock_${timestamp}`,
      },
    });
    createdAttemptId = attempt.id;

    // 6. Create DELIVERED order with deliveredAt set 1 day ago
    const order = await prisma.order.create({
      data: {
        orderNumber: `VN-CONCUR-${timestamp.toString().slice(-8)}`,
        userId: user.id,
        checkoutSessionId: session.id,
        paymentAttemptId: attempt.id,
        status: OrderStatus.DELIVERED,
        subtotal: 50000,
        tax: 0,
        discount: 0,
        totalAmount: 50000,
        currency: 'INR',
        deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Delivered 1 day ago
      },
    });
    createdOrderId = order.id;

    // 7. Create OrderItem with quantity = 1 (exactly ONE returnable unit)
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        variantId: variant.id,
        productName: product.name,
        variantName: variant.name,
        productSku: variant.sku,
        quantity: 1, // EXACTLY 1 unit
        unitPrice: 50000,
        lineTotal: 50000,
        currency: 'INR',
      },
    });
    createdOrderItemId = orderItem.id;
  });

  afterAll(async () => {
    try {
      // Clean up records in reverse FK order
      await prisma.returnItem.deleteMany({
        where: { orderItemId: createdOrderItemId },
      });
      await prisma.return.deleteMany({
        where: { orderId: createdOrderId },
      });
      await prisma.orderItem.deleteMany({
        where: { id: createdOrderItemId },
      });
      await prisma.order.deleteMany({
        where: { id: createdOrderId },
      });
      await prisma.paymentAttempt.deleteMany({
        where: { id: createdAttemptId },
      });
      await prisma.checkoutSession.deleteMany({
        where: { id: createdSessionId },
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

  it('guarantees exactly 1 return succeeds and 9 fail safely during 10-way concurrent return requests for the same single unit', async () => {
    // 10 concurrent requests simultaneously fired against PostgreSQL
    const concurrentRequests = Array.from({ length: 10 }, (_, idx) =>
      returnService.createReturn(createdOrderId, testUser, {
        items: [
          {
            orderItemId: createdOrderItemId,
            quantity: 1,
            reason: ReturnReason.DAMAGED_PRODUCT,
            notes: `Concurrent return attempt ${idx + 1}`,
          },
        ],
        customerNotes: `Concurrent batch attempt ${idx + 1}`,
      }),
    );

    // Execute all 10 concurrently
    const results = await Promise.allSettled(concurrentRequests);

    // Separate successes and rejections
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Invariant 1: Exactly 1 request succeeds
    expect(fulfilled).toHaveLength(1);

    // Invariant 2: Exactly 9 requests fail safely
    expect(rejected).toHaveLength(9);

    // Invariant 3: All 9 rejected errors are BadRequestException explaining over-allocation
    for (const r of rejected) {
      if (r.status === 'rejected') {
        const error = r.reason as Error;
        expect(error.message).toMatch(/exceeds returnable balance/i);
      }
    }

    // Invariant 4: Check PHYSICAL PostgreSQL state directly
    const physicalReturnItems = await prisma.returnItem.findMany({
      where: { orderItemId: createdOrderItemId },
    });

    // Exactly ONE return item exists in the physical database
    expect(physicalReturnItems).toHaveLength(1);
    expect(physicalReturnItems[0]!.requestedQuantity).toBe(1);

    // Exactly ONE return row exists in the physical database
    const physicalReturns = await prisma.return.findMany({
      where: { orderId: createdOrderId },
      include: { items: true },
    });
    expect(physicalReturns).toHaveLength(1);
    expect(physicalReturns[0]!.status).toBe(ReturnStatus.REQUESTED);

    // Invariant 5: Verify allocation calculation confirms 0 remaining units
    const orderItemInDb = await prisma.orderItem.findUniqueOrThrow({
      where: { id: createdOrderItemId },
    });

    const activeAllocated = physicalReturnItems.reduce((acc, ri) => {
      return acc + ri.requestedQuantity;
    }, 0);

    const remainingReturnable = orderItemInDb.quantity - activeAllocated;
    expect(activeAllocated).toBe(1);
    expect(remainingReturnable).toBe(0);
  });
});
