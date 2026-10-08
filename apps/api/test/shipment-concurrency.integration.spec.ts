import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  OrderStatus,
  ShipmentStatus,
  InventoryMovementType,
  UserRole,
} from '@prisma/client';
import { ShipmentService } from '../src/shipping/shipping.service.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

function nanoid(len = 6): string {
  return randomUUID().replace(/-/g, '').substring(0, len);
}

describe('Phase 13B.2 — Shipment Concurrency & Real PostgreSQL Row Locking', () => {
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

  let shipmentService: ShipmentService;
  let inventoryService: InventoryService;
  let auditService: AuditService;
  let permissionsService: PermissionsService;

  let adminActor: MinimalUser;
  let testUserId: string;

  beforeAll(async () => {
    await prisma.$connect();

    auditService = new AuditService(prisma);
    inventoryService = new InventoryService(prisma, auditService);
    permissionsService = new PermissionsService(prisma);
    shipmentService = new ShipmentService(
      prisma,
      auditService,
      permissionsService,
      inventoryService,
    );

    // Mock permissionsService so adminActor has full shipping permissions
    permissionsService.can = async (_user, _perm) => true;

    const suffix = nanoid(6);
    const adminUser = await prisma.user.create({
      data: {
        email: `concur-admin-${suffix}@vishkaraa.local`,
        passwordHash: 'hashed-pw',
        firstName: 'Shipping',
        lastName: 'Admin',
        role: UserRole.ADMIN,
      },
    });
    adminActor = {
      id: adminUser.id,
      role: UserRole.ADMIN,
      email: adminUser.email,
    };

    const user = await prisma.user.create({
      data: {
        email: `concur-cust-${suffix}@vishkaraa.local`,
        passwordHash: 'hashed-pw',
        firstName: 'Concur',
        lastName: 'Customer',
        role: UserRole.USER,
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Helper to create an order with inventory for testing concurrency
  async function createTestOrder(
    totalQty: number,
    initialOnHand: number = 100,
  ) {
    const suffix = nanoid(6);
    const cat = await prisma.category.create({
      data: { name: `Cat ${suffix}`, slug: `cat-${suffix}` },
    });
    const prod = await prisma.product.create({
      data: { categoryId: cat.id, name: `Prod ${suffix}`, slug: `prod-${suffix}`, status: 'ACTIVE' },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: prod.id,
        name: 'Pack 100g',
        sku: `SKU-${suffix}`,
        price: 25000,
        currency: 'INR',
      },
    });

    await prisma.inventoryItem.create({
      data: {
        variantId: variant.id,
        onHand: initialOnHand,
        committed: totalQty,
      },
    });

    const chk = await prisma.checkoutSession.create({
      data: {
        userId: testUserId,
        idempotencyKey: `chk-${suffix}`,
        expiresAt: new Date(Date.now() + 3600000),
        subtotal: totalQty * 25000,
        currency: 'INR',
      },
    });

    const pay = await prisma.paymentAttempt.create({
      data: {
        userId: testUserId,
        checkoutSessionId: chk.id,
        amount: totalQty * 25000,
        currency: 'INR',
        status: 'CAPTURED',
        provider: 'MOCK',
        idempotencyKey: `pay-${suffix}`,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `VN-${suffix.toUpperCase()}`,
        userId: testUserId,
        checkoutSessionId: chk.id,
        paymentAttemptId: pay.id,
        status: OrderStatus.CONFIRMED,
        subtotal: totalQty * 25000,
        totalAmount: totalQty * 25000,
        currency: 'INR',
        shippingName: 'Concurrency Recipient',
      },
    });

    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: prod.id,
        variantId: variant.id,
        productName: `Prod ${suffix}`,
        variantName: 'Pack 100g',
        productSku: `SKU-${suffix}`,
        quantity: totalQty,
        unitPrice: 25000,
        lineTotal: totalQty * 25000,
        currency: 'INR',
      },
    });

    return { order, orderItem, variant };
  }

  // ===========================================================================
  // 1. TWO OVERLAPPING SHIPMENT ALLOCATIONS
  // ===========================================================================
  it('guarantees invariant SUM(allocated) <= OrderItem.quantity under concurrent allocation attempts (Qty 10: Req A tries 7, Req B tries 6)', async () => {
    // Total ordered quantity = 10
    const { order, orderItem } = await createTestOrder(10, 100);

    // Simultaneously fire Request A (allocating 7) and Request B (allocating 6)
    const results = await Promise.allSettled([
      shipmentService.createShipment(adminActor, {
        orderId: order.id,
        carrierCode: 'MANUAL',
        carrierName: 'Carrier A',
        items: [{ orderItemId: orderItem.id, quantity: 7 }],
      }),
      shipmentService.createShipment(adminActor, {
        orderId: order.id,
        carrierCode: 'MANUAL',
        carrierName: 'Carrier B',
        items: [{ orderItemId: orderItem.id, quantity: 6 }],
      }),
    ]);

    // Exactly one should succeed (fulfilled), and exactly one should fail (rejected with ConflictException)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('OVER_ALLOCATION');

    // CRITICAL: Verify final database state directly via PostgreSQL query
    const dbShipmentItems = await prisma.shipmentItem.findMany({
      where: { orderItemId: orderItem.id },
    });
    const totalAllocated = dbShipmentItems.reduce((acc, item) => acc + item.quantity, 0);

    // Invariant must hold: totalAllocated <= 10
    expect(totalAllocated).toBeLessThanOrEqual(10);
    // Must be either 7 or 6 depending on which one acquired the row lock first
    expect([6, 7]).toContain(totalAllocated);
  });

  // ===========================================================================
  // 2. TWO SIMULTANEOUS DISPATCHES ON SAME SHIPMENT
  // ===========================================================================
  it('prevents double-dispatch and duplicate inventory movement when two admins dispatch the same shipment simultaneously', async () => {
    const { order, orderItem, variant } = await createTestOrder(5, 50);

    // Create and prepare shipment to READY_TO_SHIP
    const shipment = await shipmentService.createShipment(adminActor, {
      orderId: order.id,
      carrierCode: 'MANUAL',
      carrierName: 'Carrier Speed',
      items: [{ orderItemId: orderItem.id, quantity: 5 }],
    });

    await shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.PACKING,
    });
    await shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.PACKED,
    });
    await shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.READY_TO_SHIP,
    });

    // Initial inventory item state: onHand = 50, committed = 5
    const invBefore = await prisma.inventoryItem.findUnique({
      where: { variantId: variant.id },
    });
    expect(invBefore?.onHand).toBe(50);
    expect(invBefore?.committed).toBe(5);

    // Fire 2 simultaneous dispatches
    const trk1 = `TRK-CONCUR-1-${nanoid(6)}`;
    const trk2 = `TRK-CONCUR-2-${nanoid(6)}`;
    const dispatchResults = await Promise.allSettled([
      shipmentService.updateShipmentStatus(shipment.id, adminActor, {
        status: ShipmentStatus.SHIPPED,
        trackingNumber: trk1,
      }),
      shipmentService.updateShipmentStatus(shipment.id, adminActor, {
        status: ShipmentStatus.SHIPPED,
        trackingNumber: trk2,
      }),
    ]);

    // Both should resolve cleanly (one performs the transition, the other is an idempotent no-op)
    const fulfilled = dispatchResults.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);

    // CRITICAL: Verify physical inventory in DB was decremented EXACTLY ONCE
    const invAfter = await prisma.inventoryItem.findUnique({
      where: { variantId: variant.id },
    });
    expect(invAfter?.onHand).toBe(45); // 50 - 5 = 45, NOT 40
    expect(invAfter?.committed).toBe(0); // 5 - 5 = 0, NOT -5

    // Verify exactly ONE inventory movement record exists with the idempotency key
    const movements = await prisma.inventoryMovement.findMany({
      where: {
        idempotencyKey: `shp_ship_${shipment.id}_${variant.id}`,
      },
    });
    expect(movements.length).toBe(1);
    expect(movements[0]?.type).toBe(InventoryMovementType.ORDER_SHIPPED);
    expect(movements[0]?.quantityDelta).toBe(-5);

    // Verify shipment status is SHIPPED in DB
    const finalShipment = await prisma.shipment.findUnique({
      where: { id: shipment.id },
    });
    expect(finalShipment?.status).toBe(ShipmentStatus.SHIPPED);
  });

  // ===========================================================================
  // 3. DISPATCH VS CANCELLATION RACE
  // ===========================================================================
  it('ensures exactly one winner when dispatch races against pre-dispatch cancellation', async () => {
    const { order, orderItem, variant } = await createTestOrder(4, 50);

    const shipment = await shipmentService.createShipment(adminActor, {
      orderId: order.id,
      carrierCode: 'MANUAL',
      carrierName: 'Carrier Race',
      items: [{ orderItemId: orderItem.id, quantity: 4 }],
    });

    await shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.PACKING,
    });
    await shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.PACKED,
    });
    await shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.READY_TO_SHIP,
    });

    // Concurrently race: Dispatch vs Cancel
    const trkRace = `TRK-RACE-${nanoid(6)}`;
    const raceResults = await Promise.allSettled([
      shipmentService.updateShipmentStatus(shipment.id, adminActor, {
        status: ShipmentStatus.SHIPPED,
        trackingNumber: trkRace,
      }),
      shipmentService.cancelShipment(shipment.id, adminActor, {
        reason: 'Concurrent cancellation request',
      }),
    ]);

    const fulfilled = raceResults.filter((r) => r.status === 'fulfilled');
    const rejected = raceResults.filter((r) => r.status === 'rejected');

    // Exactly one operation wins
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Check DB final state
    const dbShipment = await prisma.shipment.findUnique({
      where: { id: shipment.id },
    });
    const invState = await prisma.inventoryItem.findUnique({
      where: { variantId: variant.id },
    });

    if (dbShipment?.status === ShipmentStatus.SHIPPED) {
      // Dispatch won: inventory decremented onHand: 50 - 4 = 46, committed: 0
      expect(invState?.onHand).toBe(46);
      expect(invState?.committed).toBe(0);
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain('Cannot cancel shipment that has already reached status SHIPPED');
    } else {
      // Cancel won: shipment is CANCELLED, inventory onHand untouched (50), committed remains 4 (attached to order)
      expect(dbShipment?.status).toBe(ShipmentStatus.CANCELLED);
      expect(invState?.onHand).toBe(50);
      expect(invState?.committed).toBe(4);
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/(INVALID_TRANSITION|TERMINAL_STATE)/);
    }
  });

  // ===========================================================================
  // 4. TWO FINAL SHIPMENT DELIVERIES RACING
  // ===========================================================================
  it('correctly stamps Order.deliveredAt exactly once when two final shipments are delivered concurrently', async () => {
    const { order, orderItem } = await createTestOrder(6, 60);

    // Create 2 shipments for 3 units each
    const shp1 = await shipmentService.createShipment(adminActor, {
      orderId: order.id,
      carrierCode: 'MANUAL',
      carrierName: 'Carrier 1',
      items: [{ orderItemId: orderItem.id, quantity: 3 }],
    });
    const shp2 = await shipmentService.createShipment(adminActor, {
      orderId: order.id,
      carrierCode: 'MANUAL',
      carrierName: 'Carrier 2',
      items: [{ orderItemId: orderItem.id, quantity: 3 }],
    });

    // Advance both to OUT_FOR_DELIVERY
    for (const shp of [shp1, shp2]) {
      await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.PACKING });
      await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.PACKED });
      await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.READY_TO_SHIP });
      await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.SHIPPED, trackingNumber: `TRK-${shp.id.substring(0, 6)}` });
      await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.IN_TRANSIT });
      await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.OUT_FOR_DELIVERY });
    }

    const t1 = new Date('2026-10-06T10:00:00Z');
    const t2 = new Date('2026-10-06T12:00:00Z');

    // Concurrently deliver both shipments
    const deliverResults = await Promise.allSettled([
      shipmentService.updateShipmentStatus(shp1.id, adminActor, {
        status: ShipmentStatus.DELIVERED,
        eventTimestamp: t1.toISOString(),
      }),
      shipmentService.updateShipmentStatus(shp2.id, adminActor, {
        status: ShipmentStatus.DELIVERED,
        eventTimestamp: t2.toISOString(),
      }),
    ]);

    expect(deliverResults.every((r) => r.status === 'fulfilled')).toBe(true);

    // Verify DB state
    const dbOrder = await prisma.order.findUnique({
      where: { id: order.id },
    });

    expect(dbOrder?.status).toBe(OrderStatus.DELIVERED);
    expect(dbOrder?.deliveredAt).toBeDefined();
    // Must be the MAX timestamp (t2)
    expect(new Date(dbOrder!.deliveredAt!).getTime()).toBe(t2.getTime());
  });

  // ===========================================================================
  // 5. DUPLICATE DELIVERY TRANSITION IDEMPOTENCY
  // ===========================================================================
  it('guarantees repeated delivery calls are safe no-ops and preserve existing Order.deliveredAt', async () => {
    const { order, orderItem } = await createTestOrder(2, 20);

    const shp = await shipmentService.createShipment(adminActor, {
      orderId: order.id,
      carrierCode: 'MANUAL',
      carrierName: 'Carrier 1',
      items: [{ orderItemId: orderItem.id, quantity: 2 }],
    });

    const trkDup = `TRK-DUP-${nanoid(6)}`;
    await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.PACKING });
    await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.PACKED });
    await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.READY_TO_SHIP });
    await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.SHIPPED, trackingNumber: trkDup });
    await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.IN_TRANSIT });
    await shipmentService.updateShipmentStatus(shp.id, adminActor, { status: ShipmentStatus.OUT_FOR_DELIVERY });

    const deliveryTime = new Date('2026-10-07T08:00:00Z');
    await shipmentService.updateShipmentStatus(shp.id, adminActor, {
      status: ShipmentStatus.DELIVERED,
      eventTimestamp: deliveryTime.toISOString(),
    });

    const orderAfterFirst = await prisma.order.findUnique({ where: { id: order.id } });
    expect(orderAfterFirst?.status).toBe(OrderStatus.DELIVERED);
    expect(new Date(orderAfterFirst!.deliveredAt!).getTime()).toBe(deliveryTime.getTime());

    // Duplicate delivery call
    const res = await shipmentService.updateShipmentStatus(shp.id, adminActor, {
      status: ShipmentStatus.DELIVERED,
      eventTimestamp: new Date('2026-10-08T09:00:00Z').toISOString(),
    });
    expect(res.status).toBe(ShipmentStatus.DELIVERED);

    // Verify Order.deliveredAt was NOT overwritten
    const orderAfterDup = await prisma.order.findUnique({ where: { id: order.id } });
    expect(new Date(orderAfterDup!.deliveredAt!).getTime()).toBe(deliveryTime.getTime());
  });
});
