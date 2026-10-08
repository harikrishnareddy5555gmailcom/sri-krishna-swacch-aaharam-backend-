import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, ShipmentStatus, OrderStatus, InventoryMovementType } from '@prisma/client';
import { UserRole, Permissions } from '@vishkaraa/types';
import { ShipmentService } from '../src/shipping/shipping.service.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import { ConflictException, BadRequestException } from '@nestjs/common';

describe('Phase 13B.2 — Shipment Integration Tests (Real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let shipmentService: ShipmentService;
  let inventoryService: InventoryService;
  let auditService: AuditService;
  let permissionsService: PermissionsService;

  const adminActor: MinimalUser = {
    id: 'admin-actor-uuid',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  let testUserId: string;
  let testOrderId: string;
  let testOrderItem1Id: string;
  let testOrderItem2Id: string;
  let testVariant1Id: string;
  let testVariant2Id: string;
  let testProductId: string;
  let testCategoryId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url:
            process.env['DATABASE_URL_TEST'] ||
            process.env['DATABASE_URL'] ||
            'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_naturals?schema=public',
        },
      },
    });
    await prisma.$connect();

    auditService = new AuditService(prisma as any);
    permissionsService = new PermissionsService(prisma as any, auditService);
    inventoryService = new InventoryService(prisma as any, auditService);
    shipmentService = new ShipmentService(
      prisma as any,
      auditService,
      permissionsService,
      inventoryService,
    );

    // Mock permissionsService so adminActor has full shipping permissions
    permissionsService.can = async (_user, _perm) => true;

    // Seed test fixtures
    const suffix = Math.random().toString(36).substring(2, 8);
    const adminUser = await prisma.user.create({
      data: {
        email: `shipping-admin-${suffix}@vishkaraa.local`,
        passwordHash: 'hashed-pw',
        firstName: 'Fulfillment',
        lastName: 'Admin',
        role: UserRole.ADMIN,
      },
    });
    adminActor.id = adminUser.id;

    const user = await prisma.user.create({
      data: {
        email: `shipping-integ-${suffix}@vishkaraa.local`,
        passwordHash: 'hashed-pw',
        firstName: 'Fulfillment',
        lastName: 'Manager',
        role: UserRole.USER,
      },
    });
    testUserId = user.id;

    const category = await prisma.category.create({
      data: {
        name: `Logistics Cat ${suffix}`,
        slug: `logistics-cat-${suffix}`,
      },
    });
    testCategoryId = category.id;

    const product = await prisma.product.create({
      data: {
        categoryId: testCategoryId,
        name: `Herbal Bundle ${suffix}`,
        slug: `herbal-bundle-${suffix}`,
        status: 'ACTIVE',
      },
    });
    testProductId = product.id;

    const variant1 = await prisma.productVariant.create({
      data: {
        productId: testProductId,
        name: 'Oil 500ml',
        sku: `SKU-OIL-${suffix}`,
        price: 30000,
      },
    });
    testVariant1Id = variant1.id;

    const variant2 = await prisma.productVariant.create({
      data: {
        productId: testProductId,
        name: 'Tea 250g',
        sku: `SKU-TEA-${suffix}`,
        price: 20000,
      },
    });
    testVariant2Id = variant2.id;

    // Initialize inventory for both variants with available stock
    await prisma.inventoryItem.upsert({
      where: { variantId: testVariant1Id },
      update: { onHand: 100, committed: 5, reserved: 0 },
      create: { variantId: testVariant1Id, onHand: 100, committed: 5, reserved: 0 },
    });
    await prisma.inventoryItem.upsert({
      where: { variantId: testVariant2Id },
      update: { onHand: 50, committed: 3, reserved: 0 },
      create: { variantId: testVariant2Id, onHand: 50, committed: 3, reserved: 0 },
    });

    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: testUserId,
        idempotencyKey: `chk-shp-int-${suffix}`,
        expiresAt: new Date(Date.now() + 3600000),
        subtotal: 210000,
        currency: 'INR',
      },
    });

    const payment = await prisma.paymentAttempt.create({
      data: {
        userId: testUserId,
        checkoutSessionId: checkout.id,
        amount: 210000,
        currency: 'INR',
        status: 'CAPTURED',
        provider: 'MOCK',
        idempotencyKey: `pay-shp-int-${suffix}`,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `VN-202610-INT${suffix.toUpperCase()}`,
        userId: testUserId,
        checkoutSessionId: checkout.id,
        paymentAttemptId: payment.id,
        status: OrderStatus.CONFIRMED,
        subtotal: 210000,
        totalAmount: 210000,
        currency: 'INR',
        shippingName: 'Fulfillment Tester',
        shippingPhone: '+919999999999',
        shippingLine1: '456 Warehouse Blvd',
        shippingCity: 'Bengaluru',
        shippingState: 'Karnataka',
        shippingPostalCode: '560001',
        shippingCountry: 'IN',
      },
    });
    testOrderId = order.id;

    // Item 1: Oil 500ml x 5
    const oi1 = await prisma.orderItem.create({
      data: {
        orderId: testOrderId,
        productId: testProductId,
        variantId: testVariant1Id,
        productName: 'Herbal Bundle - Oil',
        variantName: '500ml',
        productSku: `SKU-OIL-${suffix}`,
        quantity: 5,
        unitPrice: 30000,
        lineTotal: 150000,
        currency: 'INR',
      },
    });
    testOrderItem1Id = oi1.id;

    // Item 2: Tea 250g x 3
    const oi2 = await prisma.orderItem.create({
      data: {
        orderId: testOrderId,
        productId: testProductId,
        variantId: testVariant2Id,
        productName: 'Herbal Bundle - Tea',
        variantName: '250g',
        productSku: `SKU-TEA-${suffix}`,
        quantity: 3,
        unitPrice: 20000,
        lineTotal: 60000,
        currency: 'INR',
      },
    });
    testOrderItem2Id = oi2.id;
  });

  afterAll(async () => {
    try {
      await prisma.inventoryMovement.deleteMany({
        where: { variantId: { in: [testVariant1Id, testVariant2Id] } },
      });
      await prisma.inventoryItem.deleteMany({
        where: { variantId: { in: [testVariant1Id, testVariant2Id] } },
      });
      await prisma.shipmentEvent.deleteMany({
        where: { shipment: { orderId: testOrderId } },
      });
      await prisma.shipmentItem.deleteMany({
        where: { shipment: { orderId: testOrderId } },
      });
      await prisma.shipment.deleteMany({ where: { orderId: testOrderId } });
      await prisma.auditLog.deleteMany({ where: { orderId: testOrderId } });
      await prisma.orderItem.deleteMany({ where: { orderId: testOrderId } });
      await prisma.order.deleteMany({ where: { id: testOrderId } });
      await prisma.paymentAttempt.deleteMany({ where: { userId: testUserId } });
      await prisma.checkoutSession.deleteMany({ where: { userId: testUserId } });
      await prisma.productVariant.deleteMany({
        where: { id: { in: [testVariant1Id, testVariant2Id] } },
      });
      await prisma.product.deleteMany({ where: { id: testProductId } });
      await prisma.category.deleteMany({ where: { id: testCategoryId } });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    } catch (err) {
      console.warn('Cleanup error in integration test:', err);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // 1. MULTI-SHIPMENT CREATION & ALLOCATION ENFORCEMENT
  // ===========================================================================
  describe('Shipment Creation & Allocation Enforcement', () => {
    let shipment1Id: string;

    it('should create Shipment 1 with partial allocation of items', async () => {
      // Allocate: 3 of 5 Oil, 3 of 3 Tea
      const shipment = await shipmentService.createShipment(adminActor, {
        orderId: testOrderId,
        carrierCode: 'SHIPROCKET',
        carrierName: 'Shiprocket Surface',
        items: [
          { orderItemId: testOrderItem1Id, quantity: 3 },
          { orderItemId: testOrderItem2Id, quantity: 3 },
        ],
      });

      expect(shipment).toBeDefined();
      expect(shipment.status).toBe(ShipmentStatus.CREATED);
      expect(shipment.items).toHaveLength(2);
      shipment1Id = shipment.id;

      // Verify AuditLog
      const audit = await prisma.auditLog.findFirst({
        where: {
          entityId: shipment.id,
          action: 'SHIPMENT_CREATED',
        },
      });
      expect(audit).toBeDefined();
    });

    it('should reject over-allocation when remaining quantity is exceeded', async () => {
      // Tea: 3 ordered, 3 allocated -> 0 remaining
      // Oil: 5 ordered, 3 allocated -> 2 remaining

      // Attempt 1: Trying to allocate 1 more Tea (should fail with ConflictException)
      await expect(
        shipmentService.createShipment(adminActor, {
          orderId: testOrderId,
          items: [{ orderItemId: testOrderItem2Id, quantity: 1 }],
        }),
      ).rejects.toThrow(ConflictException);

      // Attempt 2: Trying to allocate 3 Oil when only 2 remain (should fail with ConflictException)
      await expect(
        shipmentService.createShipment(adminActor, {
          orderId: testOrderId,
          items: [{ orderItemId: testOrderItem1Id, quantity: 3 }],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should create Shipment 2 with exact remaining quantity', async () => {
      // Allocate exact remaining 2 Oil
      const shipment2 = await shipmentService.createShipment(adminActor, {
        orderId: testOrderId,
        carrierCode: 'DELHIVERY',
        carrierName: 'Delhivery Air',
        items: [{ orderItemId: testOrderItem1Id, quantity: 2 }],
      });

      expect(shipment2).toBeDefined();
      expect(shipment2.status).toBe(ShipmentStatus.CREATED);
      expect(shipment2.items).toHaveLength(1);
      expect(shipment2.items![0]?.quantity).toBe(2);

      // Now all quantities are 100% allocated (5 Oil, 3 Tea)
      // Any further allocation must fail
      await expect(
        shipmentService.createShipment(adminActor, {
          orderId: testOrderId,
          items: [{ orderItemId: testOrderItem1Id, quantity: 1 }],
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ===========================================================================
  // 2. DISPATCH & INVENTORY DEDUCTION
  // ===========================================================================
  describe('Dispatch & Inventory Integration', () => {
    let shipment1Id: string;
    let shipment2Id: string;

    beforeAll(async () => {
      const shipments = await prisma.shipment.findMany({
        where: { orderId: testOrderId },
        orderBy: { createdAt: 'asc' },
      });
      shipment1Id = shipments[0]!.id;
      shipment2Id = shipments[1]!.id;
    });

    it('should transition Shipment 1 through packing to READY_TO_SHIP', async () => {
      const packing = await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.PACKING,
      });
      expect(packing.status).toBe(ShipmentStatus.PACKING);

      const packed = await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.PACKED,
      });
      expect(packed.status).toBe(ShipmentStatus.PACKED);

      const ready = await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.READY_TO_SHIP,
      });
      expect(ready.status).toBe(ShipmentStatus.READY_TO_SHIP);

      // Idempotent call to READY_TO_SHIP should succeed without error
      const retryReady = await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.READY_TO_SHIP,
      });
      expect(retryReady.status).toBe(ShipmentStatus.READY_TO_SHIP);
    });

    it('should deduct physical inventory and record ORDER_SHIPPED movement upon SHIPPED', async () => {
      // Pre-dispatch inventory counts
      const inv1Before = await prisma.inventoryItem.findUnique({
        where: { variantId: testVariant1Id },
      });
      const inv2Before = await prisma.inventoryItem.findUnique({
        where: { variantId: testVariant2Id },
      });

      expect(inv1Before?.onHand).toBe(100);
      expect(inv1Before?.committed).toBe(5);
      expect(inv2Before?.onHand).toBe(50);
      expect(inv2Before?.committed).toBe(3);

      // Dispatch Shipment 1 (contains 3 Oil, 3 Tea)
      const shipped1 = await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.SHIPPED,
        trackingNumber: 'TRK-SHIPMENT-1',
      });

      expect(shipped1.status).toBe(ShipmentStatus.SHIPPED);
      expect(shipped1.shippedAt).toBeDefined();

      // Post-dispatch inventory counts:
      // Oil: committed -= 3 (2 remaining), onHand -= 3 (97 remaining)
      // Tea: committed -= 3 (0 remaining), onHand -= 3 (47 remaining)
      const inv1After = await prisma.inventoryItem.findUnique({
        where: { variantId: testVariant1Id },
      });
      const inv2After = await prisma.inventoryItem.findUnique({
        where: { variantId: testVariant2Id },
      });

      expect(inv1After?.onHand).toBe(97);
      expect(inv1After?.committed).toBe(2);
      expect(inv2After?.onHand).toBe(47);
      expect(inv2After?.committed).toBe(0);

      // Verify exact InventoryMovement records created with approved idempotency keys
      const mvt1 = await prisma.inventoryMovement.findUnique({
        where: { idempotencyKey: `shp_ship_${shipment1Id}_${testVariant1Id}` },
      });
      expect(mvt1).toBeDefined();
      expect(mvt1?.type).toBe(InventoryMovementType.ORDER_SHIPPED);
      expect(mvt1?.quantityDelta).toBe(-3);

      const mvt2 = await prisma.inventoryMovement.findUnique({
        where: { idempotencyKey: `shp_ship_${shipment1Id}_${testVariant2Id}` },
      });
      expect(mvt2).toBeDefined();
      expect(mvt2?.type).toBe(InventoryMovementType.ORDER_SHIPPED);
      expect(mvt2?.quantityDelta).toBe(-3);

      // Order status should still NOT be SHIPPED because Shipment 2 has not dispatched!
      const order = await prisma.order.findUnique({ where: { id: testOrderId } });
      expect(order?.status).toBe(OrderStatus.CONFIRMED);
    });

    it('should transition Order to SHIPPED when final shipment is dispatched', async () => {
      // Move Shipment 2 through packing to SHIPPED (contains remaining 2 Oil)
      await shipmentService.updateShipmentStatus(shipment2Id, adminActor, {
        status: ShipmentStatus.PACKING,
      });
      await shipmentService.updateShipmentStatus(shipment2Id, adminActor, {
        status: ShipmentStatus.PACKED,
      });
      await shipmentService.updateShipmentStatus(shipment2Id, adminActor, {
        status: ShipmentStatus.READY_TO_SHIP,
      });
      await shipmentService.updateShipmentStatus(shipment2Id, adminActor, {
        status: ShipmentStatus.SHIPPED,
        trackingNumber: 'TRK-SHIPMENT-2',
      });

      // Inventory for Variant 1 (Oil): committed was 2, now committed -= 2 (0 remaining), onHand -= 2 (95 remaining)
      const inv1Final = await prisma.inventoryItem.findUnique({
        where: { variantId: testVariant1Id },
      });
      expect(inv1Final?.onHand).toBe(95);
      expect(inv1Final?.committed).toBe(0);

      // NOW 100% of order items are dispatched across active shipments!
      // Order status MUST transition to SHIPPED!
      const order = await prisma.order.findUnique({ where: { id: testOrderId } });
      expect(order?.status).toBe(OrderStatus.SHIPPED);
    });
  });

  // ===========================================================================
  // 3. ORDER DELIVERY EVALUATION & ORDER.DELIVEREDAT
  // ===========================================================================
  describe('Order Delivery Evaluation', () => {
    let shipment1Id: string;
    let shipment2Id: string;

    beforeAll(async () => {
      const shipments = await prisma.shipment.findMany({
        where: { orderId: testOrderId },
        orderBy: { createdAt: 'asc' },
      });
      shipment1Id = shipments[0]!.id;
      shipment2Id = shipments[1]!.id;
    });

    it('should NOT mark Order as DELIVERED when only Shipment 1 is delivered (partial delivery)', async () => {
      // Progress Shipment 1 to DELIVERED
      await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.IN_TRANSIT,
      });
      await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.OUT_FOR_DELIVERY,
      });
      const delivered1 = await shipmentService.updateShipmentStatus(shipment1Id, adminActor, {
        status: ShipmentStatus.DELIVERED,
        eventTimestamp: new Date('2026-10-05T10:00:00Z').toISOString(),
      });

      expect(delivered1.status).toBe(ShipmentStatus.DELIVERED);
      expect(delivered1.deliveredAt).toBeDefined();

      // Check Order state: MUST remain SHIPPED, Order.deliveredAt MUST remain NULL
      const order = await prisma.order.findUnique({ where: { id: testOrderId } });
      expect(order?.status).toBe(OrderStatus.SHIPPED);
      expect(order?.deliveredAt).toBeNull();
    });

    it('should mark Order as DELIVERED and stamp Order.deliveredAt when Shipment 2 is delivered', async () => {
      const deliveryDateShipment2 = new Date('2026-10-05T14:30:00Z');

      await shipmentService.updateShipmentStatus(shipment2Id, adminActor, {
        status: ShipmentStatus.IN_TRANSIT,
      });
      await shipmentService.updateShipmentStatus(shipment2Id, adminActor, {
        status: ShipmentStatus.OUT_FOR_DELIVERY,
      });
      await shipmentService.updateShipmentStatus(shipment2Id, adminActor, {
        status: ShipmentStatus.DELIVERED,
        eventTimestamp: deliveryDateShipment2.toISOString(),
      });

      // NOW 100% of shipments and 100% of item quantities are delivered!
      // Order MUST be DELIVERED and Order.deliveredAt MUST be stamped!
      const order = await prisma.order.findUnique({ where: { id: testOrderId } });
      expect(order?.status).toBe(OrderStatus.DELIVERED);
      expect(order?.deliveredAt).toBeDefined();
      expect(new Date(order!.deliveredAt!).getTime()).toBe(deliveryDateShipment2.getTime());
    });
  });

  // ===========================================================================
  // 4. PRE-DISPATCH CANCELLATION
  // ===========================================================================
  describe('Pre-Dispatch Cancellation', () => {
    let cancelTestOrderId: string;
    let cancelShipmentId: string;

    beforeAll(async () => {
      const suffix = Math.random().toString(36).substring(2, 8);
      const chk = await prisma.checkoutSession.create({
        data: {
          userId: testUserId,
          idempotencyKey: `chk-cancel-${suffix}`,
          expiresAt: new Date(Date.now() + 3600000),
          subtotal: 30000,
          currency: 'INR',
        },
      });

      const pay = await prisma.paymentAttempt.create({
        data: {
          userId: testUserId,
          checkoutSessionId: chk.id,
          amount: 30000,
          currency: 'INR',
          status: 'CAPTURED',
          provider: 'MOCK',
          idempotencyKey: `pay-cancel-${suffix}`,
        },
      });

      const ord = await prisma.order.create({
        data: {
          orderNumber: `VN-202610-CNC${suffix.toUpperCase()}`,
          userId: testUserId,
          checkoutSessionId: chk.id,
          paymentAttemptId: pay.id,
          status: OrderStatus.CONFIRMED,
          subtotal: 30000,
          totalAmount: 30000,
          currency: 'INR',
          shippingName: 'Cancellation Tester',
        },
      });
      cancelTestOrderId = ord.id;

      const oi = await prisma.orderItem.create({
        data: {
          orderId: cancelTestOrderId,
          productId: testProductId,
          variantId: testVariant1Id,
          productName: 'Herbal Oil',
          variantName: '500ml',
          productSku: `SKU-OIL-${suffix}`,
          quantity: 2,
          unitPrice: 30000,
          lineTotal: 60000,
          currency: 'INR',
        },
      });

      const shp = await shipmentService.createShipment(adminActor, {
        orderId: cancelTestOrderId,
        carrierCode: 'MANUAL',
        carrierName: 'Local Courier',
        items: [{ orderItemId: oi.id, quantity: 2 }],
      });
      cancelShipmentId = shp.id;
    });

    afterAll(async () => {
      try {
        await prisma.shipmentEvent.deleteMany({
          where: { shipment: { orderId: cancelTestOrderId } },
        });
        await prisma.shipmentItem.deleteMany({
          where: { shipment: { orderId: cancelTestOrderId } },
        });
        await prisma.shipment.deleteMany({ where: { orderId: cancelTestOrderId } });
        await prisma.auditLog.deleteMany({ where: { orderId: cancelTestOrderId } });
        await prisma.orderItem.deleteMany({ where: { orderId: cancelTestOrderId } });
        await prisma.order.deleteMany({ where: { id: cancelTestOrderId } });
      } catch (err) {
        console.warn('Cleanup error in cancel test:', err);
      }
    });

    it('should cancel an unshipped shipment and record reason', async () => {
      const cancelled = await shipmentService.cancelShipment(cancelShipmentId, adminActor, {
        reason: 'Customer requested address change before dispatch',
      });

      expect(cancelled.status).toBe(ShipmentStatus.CANCELLED);
      expect(cancelled.cancelledAt).toBeDefined();
      expect(cancelled.cancelReason).toContain('Customer requested address change');

      // Idempotency: second cancel call succeeds as safe no-op
      const retryCancel = await shipmentService.cancelShipment(cancelShipmentId, adminActor, {
        reason: 'Customer requested address change before dispatch',
      });
      expect(retryCancel.status).toBe(ShipmentStatus.CANCELLED);
    });

    it('should strictly reject cancellation after a shipment is SHIPPED', async () => {
      // Find a shipped shipment from earlier tests
      const shippedShipment = await prisma.shipment.findFirst({
        where: { orderId: testOrderId, status: ShipmentStatus.DELIVERED },
      });

      expect(shippedShipment).toBeDefined();

      await expect(
        shipmentService.cancelShipment(shippedShipment!.id, adminActor, {
          reason: 'Attempting to cancel already dispatched package',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
