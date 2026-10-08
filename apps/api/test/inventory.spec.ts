import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  ProductStatus,
  ProductVariantStatus,
  CheckoutStatus,
  ReservationStatus,
  InventoryMovementType,
} from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';

describe('Phase 11: Inventory Domain & Ledger Integrity Unit/Integration', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_test?schema=public';

  const prisma = new PrismaClient({
    datasources: { db: { url: testDbUrl } },
  });

  let inventoryService: InventoryService;
  let testUserId: string;
  let testProductId: string;
  let testVariantId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const mockAuditService = {
      logEvent: async () => {},
    } as unknown as AuditService;

    inventoryService = new InventoryService(
      prisma as any,
      mockAuditService,
    );

    const timestamp = Date.now();

    const user = await prisma.user.create({
      data: {
        email: `inv-unit-${timestamp}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Unit',
        lastName: 'Tester',
        role: 'ADMIN',
      },
    });
    testUserId = user.id;

    const product = await prisma.product.create({
      data: {
        name: `Inv Unit Product ${timestamp}`,
        slug: `inv-unit-prod-${timestamp}`,
        status: ProductStatus.ACTIVE,
        category: {
          create: {
            name: `Inv Unit Cat ${timestamp}`,
            slug: `inv-unit-cat-${timestamp}`,
            status: 'ACTIVE',
          },
        },
      },
    });
    testProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: 'Unit Variant',
        sku: `INV-UNIT-SKU-${timestamp}`,
        price: 12000,
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    testVariantId = variant.id;
  });

  afterAll(async () => {
    try {
      await prisma.inventoryMovement.deleteMany({ where: { variantId: testVariantId } });
      await prisma.inventoryReservation.deleteMany({ where: { variantId: testVariantId } });
      await prisma.inventoryItem.deleteMany({ where: { variantId: testVariantId } });
      await prisma.productVariant.deleteMany({ where: { id: testVariantId } });
      await prisma.product.deleteMany({ where: { id: testProductId } });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    } catch {
      // Best-effort cleanup
    } finally {
      await prisma.$disconnect();
    }
  });

  it('initializes zero fabricated stock for a new variant', async () => {
    const item = await inventoryService.ensureInventoryItem(testVariantId);
    expect(item.variantId).toBe(testVariantId);
    expect(item.onHand).toBe(0);
    expect(item.reserved).toBe(0);
    expect(item.committed).toBe(0);
    expect(item.available).toBe(0);
    expect(item.isLowStock).toBe(true);
  });

  it('correctly derives available = onHand - reserved - committed', async () => {
    // Add 20 on hand
    await inventoryService.adjustStock({
      variantId: testVariantId,
      delta: 20,
      reason: 'Stock intake',
      idempotencyKey: `intake-${Date.now()}`,
      actorId: testUserId,
      actorRole: 'ADMIN',
    });

    const balance = await inventoryService.getBalance(testVariantId);
    expect(balance.onHand).toBe(20);
    expect(balance.reserved).toBe(0);
    expect(balance.committed).toBe(0);
    expect(balance.available).toBe(20);
    expect(balance.isLowStock).toBe(false);
  });

  it('releases reservations when checkout session is cancelled or replaced', async () => {
    const cart = await prisma.cart.create({
      data: { userId: testUserId, status: 'ACTIVE', currency: 'INR' },
    });
    const session = await prisma.checkoutSession.create({
      data: {
        userId: testUserId,
        cartId: cart.id,
        status: CheckoutStatus.ACTIVE,
        subtotal: 12000,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 1800 * 1000),
      },
    });

    // Reserve 5 units
    await inventoryService.reserveStock({
      checkoutSessionId: session.id,
      items: [{ variantId: testVariantId, quantity: 5 }],
      expiresAt: session.expiresAt,
      actorId: testUserId,
    });

    let balance = await inventoryService.getBalance(testVariantId);
    expect(balance.onHand).toBe(20);
    expect(balance.reserved).toBe(5);
    expect(balance.available).toBe(15);

    // Release reservation
    await inventoryService.releaseReservation(
      session.id,
      testUserId,
      'Customer cancelled checkout',
    );

    balance = await inventoryService.getBalance(testVariantId);
    expect(balance.reserved).toBe(0);
    expect(balance.available).toBe(20);

    const reservation = await prisma.inventoryReservation.findUniqueOrThrow({
      where: {
        checkoutSessionId_variantId: {
          checkoutSessionId: session.id,
          variantId: testVariantId,
        },
      },
    });
    expect(reservation.status).toBe(ReservationStatus.RELEASED);
  });

  it('enforces database check constraints rejecting negative stock via raw SQL', async () => {
    // Attempting direct raw update with negative onHand must trigger PostgreSQL CHECK constraint
    await expect(
      prisma.$executeRaw`
        UPDATE inventory_items
        SET "onHand" = -5
        WHERE "variantId" = ${testVariantId}
      `,
    ).rejects.toThrow();

    // Attempting to make onHand < reserved + committed must trigger chk_inventory_available_non_negative
    await expect(
      prisma.$executeRaw`
        UPDATE inventory_items
        SET "reserved" = 9999
        WHERE "variantId" = ${testVariantId}
      `,
    ).rejects.toThrow();
  });

  it('decrements onHand and committed stock upon order shipment', async () => {
    // 1. Setup an order with 2 committed units
    const shopper = await prisma.user.create({
      data: {
        email: `ship-shopper-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Ship',
        lastName: 'Shopper',
        role: 'USER',
      },
    });
    const cart = await prisma.cart.create({
      data: { userId: shopper.id, status: 'ACTIVE', currency: 'INR' },
    });
    const session = await prisma.checkoutSession.create({
      data: {
        userId: shopper.id,
        cartId: cart.id,
        status: CheckoutStatus.COMPLETED,
        subtotal: 24000,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 1800 * 1000),
      },
    });
    const attempt = await prisma.paymentAttempt.create({
      data: {
        userId: shopper.id,
        checkoutSessionId: session.id,
        amount: 24000,
        currency: 'INR',
        status: 'CAPTURED',
        provider: 'MOCK',
        providerOrderId: `po_ship_${Date.now()}`,
        providerPaymentId: `pp_ship_${Date.now()}`,
      },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `VN-SHIP-${Date.now().toString().slice(-8)}`,
        userId: shopper.id,
        checkoutSessionId: session.id,
        paymentAttemptId: attempt.id,
        status: 'CONFIRMED',
        subtotal: 24000,
        totalAmount: 24000,
        currency: 'INR',
        items: {
          create: [
            {
              productId: testProductId,
              variantId: testVariantId,
              productName: 'Unit Product',
              variantName: 'Unit Variant',
              productSku: 'INV-UNIT-SKU',
              quantity: 2,
              unitPrice: 12000,
              lineTotal: 24000,
              currency: 'INR',
            },
          ],
        },
      },
      include: { items: true },
    });

    // Directly set committed to 2 for this order
    const itemBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    await prisma.inventoryItem.update({
      where: { id: itemBefore.id },
      data: { committed: itemBefore.committed + 2 },
    });

    // 2. Ship order inventory
    await inventoryService.shipOrderInventory(order.id, testUserId);

    const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });

    // Physical on-hand decremented by 2, committed decremented by 2
    expect(itemAfter.onHand).toBe(itemBefore.onHand - 2);
    expect(itemAfter.committed).toBe(itemBefore.committed);

    // SHIP movement recorded
    const shipMovement = await prisma.inventoryMovement.findUnique({
      where: { idempotencyKey: `ord_ship_${order.id}_${testVariantId}` },
    });
    expect(shipMovement).not.toBeNull();
    expect(shipMovement!.type).toBe(InventoryMovementType.ORDER_SHIPPED);
    expect(shipMovement!.quantityDelta).toBe(-2);
  });
});
