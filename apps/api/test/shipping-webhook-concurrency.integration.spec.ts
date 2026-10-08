import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  ShipmentStatus,
  OrderStatus,
  InventoryMovementType,
} from '@prisma/client';
import { UserRole } from '@vishkaraa/types';
import { ShipmentService } from '../src/shipping/shipping.service.js';
import { ShippingWebhookService } from '../src/shipping/webhook/shipping-webhook.service.js';
import { ShippingWebhookController } from '../src/shipping/webhook/shipping-webhook.controller.js';
import { ShippingProviderRegistry } from '../src/shipping/providers/shipping-provider.registry.js';
import { MockShippingProvider } from '../src/shipping/providers/mock/mock-shipping.provider.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import type { Request } from 'express';

describe('Phase 13B.3 — Shipping Webhook Concurrency Tests (Real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let auditService: AuditService;
  let permissionsService: PermissionsService;
  let inventoryService: InventoryService;
  let shipmentService: ShipmentService;
  let mockProvider: MockShippingProvider;
  let providerRegistry: ShippingProviderRegistry;
  let webhookService: ShippingWebhookService;
  let webhookController: ShippingWebhookController;

  const testSecret = 'mock-shipping-webhook-secret-min-32-chars-long';
  const adminActor: MinimalUser = {
    id: 'admin-concurrency-actor-uuid',
    role: UserRole.ADMIN,
    email: 'admin-concurrency@vishkaraa.local',
  };

  let testUserId: string;
  let testVariantId: string;
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

    mockProvider = new MockShippingProvider(testSecret);
    providerRegistry = new ShippingProviderRegistry(mockProvider);
    webhookService = new ShippingWebhookService(
      prisma as any,
      providerRegistry,
      shipmentService,
    );
    webhookController = new ShippingWebhookController(webhookService);

    permissionsService.can = async (_user, _perm) => true;

    // Seed shared fixtures
    const suffix = Math.random().toString(36).substring(2, 8);
    const adminUser = await prisma.user.create({
      data: {
        email: `conc_admin_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Concurrency',
        lastName: 'Admin',
        role: UserRole.ADMIN,
      },
    });
    testUserId = adminUser.id;
    adminActor.id = adminUser.id;

    const category = await prisma.category.create({
      data: {
        name: `Conc Cat ${suffix}`,
        slug: `conc-cat-${suffix}`,
      },
    });
    testCategoryId = category.id;

    const product = await prisma.product.create({
      data: {
        name: `Conc Prod ${suffix}`,
        slug: `conc-prod-${suffix}`,
        categoryId: testCategoryId,
        status: 'ACTIVE',
      },
    });
    testProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: testProductId,
        name: '500ml',
        sku: `SKU-WCONC-${suffix}`,
        price: 49900,
      },
    });
    testVariantId = variant.id;

    await prisma.inventoryItem.upsert({
      where: { variantId: testVariantId },
      update: { onHand: 500, committed: 0, reserved: 0 },
      create: { variantId: testVariantId, onHand: 500, committed: 0, reserved: 0 },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrderAndShipment(initialStatus: ShipmentStatus = ShipmentStatus.READY_TO_SHIP) {
    const sfx = Math.random().toString(36).substring(2, 8);

    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: testUserId,
        idempotencyKey: `chk-shp-conc-${sfx}`,
        expiresAt: new Date(Date.now() + 3600000),
        subtotal: 99800,
        currency: 'INR',
      },
    });

    const payment = await prisma.paymentAttempt.create({
      data: {
        userId: testUserId,
        checkoutSessionId: checkout.id,
        amount: 99800,
        currency: 'INR',
        status: 'CAPTURED',
        provider: 'MOCK',
        idempotencyKey: `pay-shp-conc-${sfx}`,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-CONC-${sfx.toUpperCase()}`,
        userId: testUserId,
        checkoutSessionId: checkout.id,
        paymentAttemptId: payment.id,
        status: OrderStatus.PROCESSING,
        subtotal: 99800,
        totalAmount: 99800,
        currency: 'INR',
        shippingName: 'Concurrency Customer',
        shippingPhone: '+919999999999',
        shippingLine1: '123 Test St',
        shippingCity: 'Bengaluru',
        shippingState: 'Karnataka',
        shippingPostalCode: '560001',
        shippingCountry: 'IN',
      },
    });

    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: testProductId,
        variantId: testVariantId,
        productName: 'Concurrency Product',
        variantName: '500ml',
        productSku: `SKU-WCONC-${sfx}`,
        quantity: 2,
        unitPrice: 49900,
        lineTotal: 99800,
        currency: 'INR',
      },
    });

    // Allocate inventory committed count
    await prisma.inventoryItem.upsert({
      where: { variantId: testVariantId },
      update: { committed: { increment: 2 } },
      create: { variantId: testVariantId, onHand: 500, committed: 2, reserved: 0 },
    });

    const trackingNumber = `MCK-CONC-${sfx.toUpperCase()}`;
    const providerShipmentId = `mock_shp_conc_${sfx}`;

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        userId: testUserId,
        shipmentNumber: `SHP-CONC-${sfx}`,
        status: initialStatus,
        carrierCode: 'MOCK',
        carrierName: 'Mock Logistics Express',
        trackingNumber: initialStatus === ShipmentStatus.PACKED ? null : trackingNumber,
        providerShipmentId,
        weightGrams: 1000,
        shippedAt:
          initialStatus === ShipmentStatus.SHIPPED ||
          initialStatus === ShipmentStatus.IN_TRANSIT ||
          initialStatus === ShipmentStatus.OUT_FOR_DELIVERY ||
          initialStatus === ShipmentStatus.DELIVERED
            ? new Date()
            : null,
        items: {
          create: [
            {
              orderItemId: orderItem.id,
              variantId: testVariantId,
              productName: 'Concurrency Product',
              productSku: `SKU-WCONC-${sfx}`,
              quantity: 2,
            },
          ],
        },
      },
      include: {
        items: true,
      },
    });

    return { order, orderItem, shipment, trackingNumber, providerShipmentId };
  }

  function createSignedRequest(rawPayload: Record<string, unknown>, secret = testSecret): Request {
    const rawBuffer = Buffer.from(JSON.stringify(rawPayload), 'utf8');
    const signature = MockShippingProvider.generateSignature(rawBuffer, secret);
    return {
      body: rawBuffer,
      headers: {
        'x-mock-signature': signature,
        'content-type': 'application/json',
      },
    } as unknown as Request;
  }

  async function postWebhook(provider: string, req: Request) {
    return webhookController.handleShippingWebhook(
      provider,
      req,
      (req.headers || {}) as Record<string, string>,
    );
  }

  // ===========================================================================
  // 1. CONCURRENT DUPLICATE WEBHOOK RACE
  // ===========================================================================
  it('handles 2 concurrent identical webhooks with exactly one processing and one duplicate ignored', async () => {
    const { shipment, trackingNumber, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.READY_TO_SHIP,
    );

    const eventId = `evt-race-dup-${Math.random().toString(36).substring(2, 8)}`;
    const payload = {
      eventId,
      providerShipmentId,
      trackingNumber,
      status: 'PICKED_UP',
      eventTimestamp: new Date().toISOString(),
    };

    const reqA = createSignedRequest(payload);
    const reqB = createSignedRequest(payload);

    // Fire concurrently
    const [resA, resB] = await Promise.all([
      postWebhook('MOCK', reqA),
      postWebhook('MOCK', reqB),
    ]);

    expect(resA.received).toBe(true);
    expect(resB.received).toBe(true);

    const results = [resA.result, resB.result];
    expect(results).toContain('TRANSITION_APPLIED');
    expect(results).toContain('DUPLICATE_IGNORED');

    // Exactly one ledger record in DB
    const ledgerCount = await prisma.shipmentWebhookEvent.count({
      where: { provider: 'MOCK', eventId },
    });
    expect(ledgerCount).toBe(1);

    // Final shipment status is SHIPPED
    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.SHIPPED);

    // Inventory movement created exactly once
    const movements = await prisma.inventoryMovement.findMany({
      where: { idempotencyKey: `shp_ship_${shipment.id}_${testVariantId}` },
    });
    expect(movements).toHaveLength(1);
  });

  // ===========================================================================
  // 2. WEBHOOK DISPATCH RACING MANUAL ADMIN DISPATCH
  // ===========================================================================
  it('handles concurrent admin dispatch and webhook dispatch safely without double deduction', async () => {
    const { shipment, trackingNumber, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.READY_TO_SHIP,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    const onHandBefore = invBefore.onHand;
    const committedBefore = invBefore.committed;

    const eventId = `evt-race-admin-disp-${Math.random().toString(36).substring(2, 8)}`;
    const webhookReq = createSignedRequest({
      eventId,
      providerShipmentId,
      trackingNumber,
      status: 'PICKED_UP',
      eventTimestamp: new Date().toISOString(),
    });

    // Concurrently fire admin status transition and webhook
    const adminPromise = shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.SHIPPED,
      trackingNumber,
    });
    const webhookPromise = postWebhook('MOCK', webhookReq);

    const [adminRes, webhookRes] = await Promise.allSettled([
      adminPromise,
      webhookPromise,
    ]);

    // Both promises should settle successfully (one transitions, other is safe idempotent no-op)
    expect(adminRes.status).toBe('fulfilled');
    expect(webhookRes.status).toBe('fulfilled');

    // Status must be SHIPPED
    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.SHIPPED);

    // Physical inventory deducted exactly once (2 items)
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(onHandBefore - 2);
    expect(invAfter.committed).toBe(committedBefore - 2);

    // InventoryMovement ORDER_SHIPPED exists exactly once
    const movements = await prisma.inventoryMovement.findMany({
      where: { idempotencyKey: `shp_ship_${shipment.id}_${testVariantId}` },
    });
    expect(movements).toHaveLength(1);
  });

  // ===========================================================================
  // 3. WEBHOOK DELIVERY RACING MANUAL ADMIN DELIVERY
  // ===========================================================================
  it('handles concurrent admin delivery and webhook delivery safely', async () => {
    const { order, shipment, trackingNumber, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.OUT_FOR_DELIVERY,
    );

    const eventId = `evt-race-del-${Math.random().toString(36).substring(2, 8)}`;
    const webhookReq = createSignedRequest({
      eventId,
      providerShipmentId,
      trackingNumber,
      status: 'DELIVERED',
      eventTimestamp: new Date().toISOString(),
    });

    const adminPromise = shipmentService.updateShipmentStatus(shipment.id, adminActor, {
      status: ShipmentStatus.DELIVERED,
    });
    const webhookPromise = postWebhook('MOCK', webhookReq);

    const [adminRes, webhookRes] = await Promise.allSettled([
      adminPromise,
      webhookPromise,
    ]);

    expect(adminRes.status).toBe('fulfilled');
    expect(webhookRes.status).toBe('fulfilled');

    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(dbShipment.deliveredAt).toBeDefined();

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.DELIVERED);
    expect(dbOrder.deliveredAt).toBeDefined();
  });

  // ===========================================================================
  // 4. WEBHOOK DISPATCH RACING MANUAL CANCELLATION
  // ===========================================================================
  it('handles concurrent admin cancellation and webhook dispatch safely without inconsistent state', async () => {
    const { shipment, trackingNumber, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.READY_TO_SHIP,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    const onHandBefore = invBefore.onHand;
    const committedBefore = invBefore.committed;

    const eventId = `evt-race-cancel-${Math.random().toString(36).substring(2, 8)}`;
    const webhookReq = createSignedRequest({
      eventId,
      providerShipmentId,
      trackingNumber,
      status: 'PICKED_UP',
      eventTimestamp: new Date().toISOString(),
    });

    const cancelPromise = shipmentService.cancelShipment(shipment.id, adminActor, {
      reason: 'Customer requested cancellation before courier arrived',
    });
    const webhookPromise = postWebhook('MOCK', webhookReq);

    const [cancelResult, webhookResult] = await Promise.allSettled([
      cancelPromise,
      webhookPromise,
    ]);

    // Inspect DB final state
    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });

    if (dbShipment.status === ShipmentStatus.CANCELLED) {
      // Cancellation won the race:
      // Items returned to order unfulfilled pool for re-packing, physical onHand and committed unchanged
      expect(cancelResult.status).toBe('fulfilled');
      expect(invAfter.onHand).toBe(onHandBefore);
      expect(invAfter.committed).toBe(committedBefore);

      // Webhook arrived on terminal CANCELLED shipment -> flagged reconciliationRequired, did NOT mutate status
      expect(dbShipment.reconciliationRequired).toBe(true);
    } else {
      // Webhook dispatch won the race:
      // Shipment is SHIPPED
      expect(dbShipment.status).toBe(ShipmentStatus.SHIPPED);
      // Cancel must have failed with ConflictException (pre-dispatch only)
      expect(cancelResult.status).toBe('rejected');
      // Inventory was deducted
      expect(invAfter.onHand).toBe(onHandBefore - 2);
      expect(invAfter.committed).toBe(committedBefore - 2);
    }
  });

  // ===========================================================================
  // 5. TEST D: CONCURRENT EARLY DELIVERED EVENTS REMAIN SAFE
  // ===========================================================================
  it('TEST D: handles concurrent early DELIVERED events safely with exactly one inventory deduction', async () => {
    const { order, shipment, trackingNumber, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.PACKED,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    const onHandBefore = invBefore.onHand;
    const committedBefore = invBefore.committed;

    const eventIdA = `evt-conc-del-a-${Math.random().toString(36).substring(2, 8)}`;
    const eventIdB = `evt-conc-del-b-${Math.random().toString(36).substring(2, 8)}`;

    const reqA = createSignedRequest({
      eventId: eventIdA,
      providerShipmentId,
      trackingNumber,
      status: 'DELIVERED',
      dispatchMilestone: 'PICKED_UP',
      eventTimestamp: new Date().toISOString(),
    });

    const reqB = createSignedRequest({
      eventId: eventIdB,
      providerShipmentId,
      trackingNumber,
      status: 'DELIVERED',
      dispatchMilestone: 'PICKED_UP',
      eventTimestamp: new Date().toISOString(),
    });

    // Fire both early DELIVERED webhooks concurrently
    const [resA, resB] = await Promise.all([
      postWebhook('MOCK', reqA),
      postWebhook('MOCK', reqB),
    ]);

    expect(resA.received).toBe(true);
    expect(resB.received).toBe(true);

    const results = [resA.result, resB.result];
    expect(results).toContain('EARLY_DELIVERY_AUTO_RECONCILED');

    // Final shipment state is DELIVERED
    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(dbShipment.deliveredAt).toBeDefined();

    // Inventory was deducted EXACTLY ONCE (2 items)
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(onHandBefore - 2);
    expect(invAfter.committed).toBe(committedBefore - 2);

    // Exactly one ORDER_SHIPPED inventory movement
    const movements = await prisma.inventoryMovement.findMany({
      where: { idempotencyKey: `shp_ship_${shipment.id}_${testVariantId}` },
    });
    expect(movements).toHaveLength(1);

    // Order status is DELIVERED
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.DELIVERED);
  });

  // ===========================================================================
  // 6. TEST E: ADMIN CANCELLATION RACING EARLY DELIVERED
  // ===========================================================================
  it('TEST E: admin cancellation racing early DELIVERED remains deterministic', async () => {
    const { shipment, trackingNumber, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.PACKED,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    const onHandBefore = invBefore.onHand;
    const committedBefore = invBefore.committed;

    const eventId = `evt-race-cancel-early-${Math.random().toString(36).substring(2, 8)}`;
    const webhookReq = createSignedRequest({
      eventId,
      providerShipmentId,
      trackingNumber,
      status: 'DELIVERED',
      dispatchMilestone: 'PICKED_UP',
      eventTimestamp: new Date().toISOString(),
    });

    const cancelPromise = shipmentService.cancelShipment(shipment.id, adminActor, {
      reason: 'Admin cancelled order before delivery confirmed',
    });
    const webhookPromise = postWebhook('MOCK', webhookReq);

    const [cancelResult, webhookResult] = await Promise.allSettled([
      cancelPromise,
      webhookPromise,
    ]);

    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });

    if (dbShipment.status === ShipmentStatus.CANCELLED) {
      // Admin cancel won:
      expect(cancelResult.status).toBe('fulfilled');
      // No inventory was deducted
      expect(invAfter.onHand).toBe(onHandBefore);
      expect(invAfter.committed).toBe(committedBefore);
      // Webhook flagged reconciliation on terminal cancelled shipment
      expect(dbShipment.reconciliationRequired).toBe(true);
    } else {
      // Early DELIVERED won:
      expect(dbShipment.status).toBe(ShipmentStatus.DELIVERED);
      // Cancel was rejected because shipment is no longer pre-dispatch
      expect(cancelResult.status).toBe('rejected');
      // Inventory was deducted exactly once
      expect(invAfter.onHand).toBe(onHandBefore - 2);
      expect(invAfter.committed).toBe(committedBefore - 2);
    }
  });
});
