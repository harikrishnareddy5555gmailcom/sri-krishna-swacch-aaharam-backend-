import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  ShipmentStatus,
  OrderStatus,
  InventoryMovementType,
} from '@prisma/client';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { UserRole, Permissions, AuditAction } from '@vishkaraa/types';
import { ShipmentService } from '../src/shipping/shipping.service.js';
import { ShippingWebhookService } from '../src/shipping/webhook/shipping-webhook.service.js';
import { ShippingWebhookController } from '../src/shipping/webhook/shipping-webhook.controller.js';
import { ShippingReconciliationService } from '../src/shipping/reconciliation/shipping-reconciliation.service.js';
import { ShippingProviderRegistry } from '../src/shipping/providers/shipping-provider.registry.js';
import { MockShippingProvider } from '../src/shipping/providers/mock/mock-shipping.provider.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import type { Request } from 'express';

describe('Phase 13B.3 — Shipping Webhook & Reconciliation Integration Tests (Real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let auditService: AuditService;
  let permissionsService: PermissionsService;
  let inventoryService: InventoryService;
  let shipmentService: ShipmentService;
  let mockProvider: MockShippingProvider;
  let providerRegistry: ShippingProviderRegistry;
  let webhookService: ShippingWebhookService;
  let webhookController: ShippingWebhookController;
  let reconciliationService: ShippingReconciliationService;

  const testSecret = 'mock-shipping-webhook-secret-min-32-chars-long';
  const adminActor: MinimalUser = {
    id: 'admin-recon-actor-uuid',
    role: UserRole.ADMIN,
    email: 'admin-recon@vishkaraa.local',
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
    reconciliationService = new ShippingReconciliationService(
      shipmentService,
      permissionsService,
    );

    permissionsService.can = async (_user, _perm) => true;

    // Seed shared fixtures
    const suffix = Math.random().toString(36).substring(2, 8);
    const adminUser = await prisma.user.create({
      data: {
        email: `recon_admin_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Recon',
        lastName: 'Admin',
        role: UserRole.ADMIN,
      },
    });
    testUserId = adminUser.id;
    adminActor.id = adminUser.id;

    const category = await prisma.category.create({
      data: {
        name: `Recon Cat ${suffix}`,
        slug: `recon-cat-${suffix}`,
      },
    });
    testCategoryId = category.id;

    const product = await prisma.product.create({
      data: {
        name: `Recon Prod ${suffix}`,
        slug: `recon-prod-${suffix}`,
        categoryId: testCategoryId,
        status: 'ACTIVE',
      },
    });
    testProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: testProductId,
        name: '500ml',
        sku: `SKU-WRECON-${suffix}`,
        price: 49900,
      },
    });
    testVariantId = variant.id;

    await prisma.inventoryItem.upsert({
      where: { variantId: testVariantId },
      update: { onHand: 100, committed: 0, reserved: 0 },
      create: { variantId: testVariantId, onHand: 100, committed: 0, reserved: 0 },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrderAndShipment(initialStatus: ShipmentStatus = ShipmentStatus.PACKED) {
    const sfx = Math.random().toString(36).substring(2, 8);

    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: testUserId,
        idempotencyKey: `chk-shp-wh-${sfx}`,
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
        idempotencyKey: `pay-shp-wh-${sfx}`,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-WH-${sfx.toUpperCase()}`,
        userId: testUserId,
        checkoutSessionId: checkout.id,
        paymentAttemptId: payment.id,
        status: OrderStatus.PROCESSING,
        subtotal: 99800,
        totalAmount: 99800,
        currency: 'INR',
        shippingName: 'Jane Customer',
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
        productName: 'Recon Product',
        variantName: '500ml',
        productSku: `SKU-WRECON-${sfx}`,
        quantity: 2,
        unitPrice: 49900,
        lineTotal: 99800,
        currency: 'INR',
      },
    });

    // Ensure inventory has committed stock for this order
    await prisma.inventoryItem.upsert({
      where: { variantId: testVariantId },
      update: { onHand: 100, committed: 2, reserved: 0 },
      create: { variantId: testVariantId, onHand: 100, committed: 2, reserved: 0 },
    });

    const trackingNumber = `MCK-TRK-${sfx.toUpperCase()}`;
    const providerShipmentId = `mock_shp_${sfx}`;

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        userId: testUserId,
        shipmentNumber: `SHP-WH-${sfx}`,
        status: initialStatus,
        carrierCode: 'MOCK',
        carrierName: 'Mock Logistics Express',
        trackingNumber: initialStatus === ShipmentStatus.PACKED ? null : trackingNumber,
        providerShipmentId,
        weightGrams: 1000,
        shippedAt:
          initialStatus === ShipmentStatus.SHIPPED ||
          initialStatus === ShipmentStatus.IN_TRANSIT ||
          initialStatus === ShipmentStatus.DELIVERED
            ? new Date()
            : null,
        items: {
          create: [
            {
              orderItemId: orderItem.id,
              variantId: testVariantId,
              productName: 'Recon Product',
              productSku: `SKU-WRECON-${sfx}`,
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

  // ─── 1. Signature & Ingress Security ────────────────────────────────────────

  it('rejects webhook with missing or invalid signature (HTTP 400)', async () => {
    const payload = { eventId: 'evt-sec-01', status: 'IN_TRANSIT' };
    const req = {
      body: Buffer.from(JSON.stringify(payload), 'utf8'),
      headers: { 'x-mock-signature': 'invalid-signature-hex' },
    } as unknown as Request;

    await expect(postWebhook('MOCK', req)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects unsupported provider code with HTTP 400', async () => {
    const payload = { eventId: 'evt-sec-02', status: 'IN_TRANSIT' };
    const req = createSignedRequest(payload);

    await expect(postWebhook('NON_EXISTENT_COURIER', req)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ─── 2. Idempotency & Duplicate Events (Scenario A) ──────────────────────────

  it('processes valid webhook and ignores duplicate eventId idempotently', async () => {
    const { shipment, trackingNumber, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.READY_TO_SHIP,
    );

    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { trackingNumber },
    });

    const eventId = `evt-dup-${Math.random().toString(36).substring(2, 8)}`;
    const payload = {
      eventId,
      providerShipmentId,
      trackingNumber,
      status: 'PICKED_UP',
      eventTimestamp: new Date().toISOString(),
      description: 'Package picked up from warehouse',
    };

    const req1 = createSignedRequest(payload);
    const res1 = await postWebhook('MOCK', req1);
    expect(res1.received).toBe(true);
    expect(res1.result).not.toBe('DUPLICATE_IGNORED');

    // Verify DB updated to SHIPPED
    const dbShipment1 = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment1.status).toBe(ShipmentStatus.SHIPPED);

    // Verify ShipmentWebhookEvent recorded
    const webhookLedger = await prisma.shipmentWebhookEvent.findUnique({
      where: {
        provider_eventId: {
          provider: 'MOCK',
          eventId,
        },
      },
    });
    expect(webhookLedger).toBeDefined();
    expect(webhookLedger?.processedAt).toBeDefined();

    // Send exact same webhook again
    const req2 = createSignedRequest(payload);
    const res2 = await postWebhook('MOCK', req2);
    expect(res2.received).toBe(true);
    expect(res2.result).toBe('DUPLICATE_IGNORED');

    const dbShipment2 = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment2.status).toBe(ShipmentStatus.SHIPPED);
  });

  // ─── 3. Replayed Event (Scenario B) ──────────────────────────────────────────

  it('replayed event with different eventId but same status records event without state mutation', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.SHIPPED,
    );

    const event1Id = `evt-rep-1-${Date.now()}`;
    const payload1 = {
      eventId: event1Id,
      providerShipmentId,
      trackingNumber,
      status: 'IN_TRANSIT',
      eventTimestamp: new Date().toISOString(),
      description: 'Arrived at hub 1',
    };
    await postWebhook('MOCK', createSignedRequest(payload1));

    const dbShipment1 = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment1.status).toBe(ShipmentStatus.IN_TRANSIT);

    const event2Id = `evt-rep-2-${Date.now()}`;
    const payload2 = {
      eventId: event2Id,
      providerShipmentId,
      trackingNumber,
      status: 'IN_TRANSIT',
      eventTimestamp: new Date(Date.now() + 1000).toISOString(),
      description: 'Second scan at same hub',
    };
    const res2 = await postWebhook('MOCK', createSignedRequest(payload2));
    expect(res2.received).toBe(true);
    expect(res2.result).not.toBe('DUPLICATE_IGNORED');

    const dbShipment2 = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment2.status).toBe(ShipmentStatus.IN_TRANSIT);

    const events = await prisma.shipmentEvent.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  // ─── 4. Stale Event (Scenario C) ─────────────────────────────────────────────

  it('stale event older than last recorded event marks isStale: true and does not regress state', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.SHIPPED,
    );

    const futureTime = new Date(Date.now() + 60000);
    const olderTime = new Date(Date.now() - 60000);

    const event1Id = `evt-stale-new-${Date.now()}`;
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId: event1Id,
        providerShipmentId,
        trackingNumber,
        status: 'OUT_FOR_DELIVERY',
        eventTimestamp: futureTime.toISOString(),
      }),
    );

    const sAfterNew = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(sAfterNew.status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);

    const event2Id = `evt-stale-old-${Date.now()}`;
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId: event2Id,
        providerShipmentId,
        trackingNumber,
        status: 'IN_TRANSIT',
        eventTimestamp: olderTime.toISOString(),
      }),
    );

    // Status MUST NOT regress backward to IN_TRANSIT
    const sAfterOld = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(sAfterOld.status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);

    const staleEvent = await prisma.shipmentEvent.findFirst({
      where: { shipmentId: shipment.id, statusCode: 'IN_TRANSIT' },
    });
    expect(staleEvent?.isStale).toBe(true);
  });

  // ─── 5. Forward Leap (Scenario D) ────────────────────────────────────────────

  it('forward leap (SHIPPED directly to OUT_FOR_DELIVERY) succeeds without fake intermediate milestones', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.SHIPPED,
    );

    const eventId = `evt-leap-${Date.now()}`;
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'OUT_FOR_DELIVERY',
        eventTimestamp: new Date().toISOString(),
      }),
    );

    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);

    const inTransitEvent = await prisma.shipmentEvent.findFirst({
      where: { shipmentId: shipment.id, statusCode: 'IN_TRANSIT' },
    });
    expect(inTransitEvent).toBeNull();
  });

  // ─── 6. Early DELIVERED / Dispatch Auto-Reconciliation (Scenario F) ──────────

  // TEST B: DELIVERED + explicit PICKED_UP/HANDOVER/DISPATCHED evidence => dispatch + delivery succeeds
  it('TEST B: early DELIVERED with explicit trusted dispatch evidence auto-reconciles inventory dispatch and marks delivered', async () => {
    const { order, shipment, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.PACKED,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    const onHandBefore = invBefore.onHand;
    const committedBefore = invBefore.committed;

    const eventId = `evt-early-del-${Date.now()}`;
    const trackingNumber = `MCK-PROOF-${Date.now()}`;

    // Webhook includes explicit trusted dispatch milestone
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'DELIVERED',
        dispatchMilestone: 'PICKED_UP',
        eventTimestamp: new Date().toISOString(),
      }),
    );

    // 1. Shipment should be auto-reconciled to DELIVERED
    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(dbShipment.shippedAt).toBeDefined();
    expect(dbShipment.deliveredAt).toBeDefined();
    expect(dbShipment.trackingNumber).toBe(trackingNumber);
    expect(dbShipment.reconciliationRequired).toBe(false);

    // 2. Inventory should be deducted (onHand -= 2, committed -= 2)
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(onHandBefore - 2);
    expect(invAfter.committed).toBe(committedBefore - 2);

    // 3. Inventory movement ORDER_SHIPPED recorded
    const movement = await prisma.inventoryMovement.findUnique({
      where: { idempotencyKey: `shp_ship_${shipment.id}_${testVariantId}` },
    });
    expect(movement).toBeDefined();
    expect(movement?.type).toBe(InventoryMovementType.ORDER_SHIPPED);

    // 4. Order deliveredAt should be set
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.DELIVERED);
    expect(dbOrder.deliveredAt).toBeDefined();
  });

  // TEST A: DELIVERED + tracking number only => reconciliationRequired, NO inventory deduction
  it('TEST A: early DELIVERED with tracking number only (no dispatch evidence) flags reconciliationRequired and leaves inventory untouched', async () => {
    const { order, shipment, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.PACKED,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });

    const eventId = `evt-ambig-del-${Date.now()}`;
    const trackingNumber = `MCK-TRK-ONLY-${Date.now()}`;

    // Webhook sends DELIVERED with valid tracking number, but NO trusted physical dispatch milestone
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'DELIVERED',
        eventTimestamp: new Date().toISOString(),
      }),
    );

    // Shipment remains PACKED with reconciliationRequired = true
    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.PACKED);
    expect(dbShipment.reconciliationRequired).toBe(true);
    expect(dbShipment.shippedAt).toBeNull();
    expect(dbShipment.deliveredAt).toBeNull();
    expect(dbShipment.reconciliationNotes).toContain('Carrier reported DELIVERED for pre-dispatch shipment');
    expect(dbShipment.reconciliationNotes).toContain('without verified physical dispatch evidence');

    // Inventory remains 100% untouched
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(invBefore.onHand);
    expect(invAfter.committed).toBe(invBefore.committed);

    // Order remains in PROCESSING
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.PROCESSING);
    expect(dbOrder.deliveredAt).toBeNull();

    // AuditLog recorded for SHIPMENT_RECONCILIATION_REQUIRED
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entityId: shipment.id,
        action: AuditAction.SHIPMENT_RECONCILIATION_REQUIRED,
      },
    });
    expect(auditLogs.length).toBeGreaterThan(0);
  });

  // TEST C: Repeated early DELIVERED event cannot double-deduct inventory
  it('TEST C: repeated early DELIVERED event cannot double-deduct inventory', async () => {
    const { shipment, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.PACKED,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    const onHandBefore = invBefore.onHand;
    const committedBefore = invBefore.committed;

    const eventId = `evt-repeat-early-${Date.now()}`;
    const trackingNumber = `MCK-REPEAT-${Date.now()}`;
    const payload = {
      eventId,
      providerShipmentId,
      trackingNumber,
      status: 'DELIVERED',
      dispatchMilestone: 'HANDOVER_TO_COURIER',
      eventTimestamp: new Date().toISOString(),
    };

    // First arrival: processes transition & deducts inventory
    const res1 = await postWebhook('MOCK', createSignedRequest(payload));
    expect(res1.received).toBe(true);
    expect(res1.result).toBe('EARLY_DELIVERY_AUTO_RECONCILED');

    const invAfterFirst = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfterFirst.onHand).toBe(onHandBefore - 2);
    expect(invAfterFirst.committed).toBe(committedBefore - 2);

    // Second arrival with exact same eventId: duplicate ignored
    const res2 = await postWebhook('MOCK', createSignedRequest(payload));
    expect(res2.received).toBe(true);
    expect(res2.result).toBe('DUPLICATE_IGNORED');

    const invAfterSecond = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfterSecond.onHand).toBe(onHandBefore - 2);
    expect(invAfterSecond.committed).toBe(committedBefore - 2);

    // Third arrival with different eventId: safe no-op on already terminal DELIVERED shipment
    const payload3 = {
      ...payload,
      eventId: `evt-repeat-diff-${Date.now()}`,
    };
    const res3 = await postWebhook('MOCK', createSignedRequest(payload3));
    expect(res3.received).toBe(true);

    const invAfterThird = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfterThird.onHand).toBe(onHandBefore - 2);
    expect(invAfterThird.committed).toBe(committedBefore - 2);
  });

  // TEST F: Unknown/untrusted provider payload fields cannot be interpreted as dispatch evidence
  it('TEST F: unknown or untrusted provider payload fields cannot be interpreted as dispatch evidence', async () => {
    const { order, shipment, providerShipmentId } = await createOrderAndShipment(
      ShipmentStatus.PACKED,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });

    const eventId = `evt-untrusted-${Date.now()}`;
    const trackingNumber = `MCK-UNTRUSTED-${Date.now()}`;

    // Payload includes untrusted arbitrary flags
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'DELIVERED',
        arbitraryCourierFlag: true,
        isDispatched: true,
        hasLeftBuilding: 'YES',
        carrierNote: 'Order manifests and data received',
        eventTimestamp: new Date().toISOString(),
      }),
    );

    // Status remains PACKED, reconciliationRequired = true, NO inventory mutation
    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.PACKED);
    expect(dbShipment.reconciliationRequired).toBe(true);
    expect(dbShipment.shippedAt).toBeNull();
    expect(dbShipment.deliveredAt).toBeNull();

    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(invBefore.onHand);
    expect(invAfter.committed).toBe(invBefore.committed);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.PROCESSING);
  });

  // ─── 7. Terminal Conflict & Impossible Transition (Scenario E) ───────────────

  it('impossible transition on CANCELLED shipment flags reconciliationRequired without mutating state', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.CANCELLED,
    );

    const eventId = `evt-term-conflict-${Date.now()}`;
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'DELIVERED',
      }),
    );

    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.CANCELLED);
    expect(dbShipment.reconciliationRequired).toBe(true);
    expect(dbShipment.reconciliationNotes).toContain('Conflicting event');

    // AuditLog recorded for SHIPMENT_RECONCILIATION_REQUIRED
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entityId: shipment.id,
        action: AuditAction.SHIPMENT_RECONCILIATION_REQUIRED,
      },
    });
    expect(auditLogs.length).toBeGreaterThan(0);
  });

  // ─── 8. Unknown Provider Status (Scenario G) ─────────────────────────────────

  it('unknown courier status flags reconciliationRequired without guessing state', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.IN_TRANSIT,
    );

    const eventId = `evt-unknown-st-${Date.now()}`;
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'COURIER_WEIRD_STATUS_CODE_999',
      }),
    );

    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(dbShipment.reconciliationRequired).toBe(true);
    expect(dbShipment.reconciliationNotes).toContain('Unrecognized provider status');
  });

  // ─── 9. RTO_DELIVERED Physical Restock Gate (Scenario H) ─────────────────────

  it('RTO_DELIVERED transitions shipment status but strictly does NOT restock inventory automatically', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.SHIPPED,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });

    const eventId = `evt-rto-del-${Date.now()}`;
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'RTO_DELIVERED',
      }),
    );

    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.RTO_DELIVERED);

    // CRITICAL: Inventory onHand count MUST NOT increase automatically
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(invBefore.onHand);

    // Verify note indicates quarantine at dock
    expect(dbShipment.reconciliationNotes).toContain('quarantine');
  });

  // ─── 10. LOST Physical Safety Invariant (Scenario I) ─────────────────────────

  it('LOST transitions status but does NOT mutate inventory or invoices', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.IN_TRANSIT,
    );

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });

    const eventId = `evt-lost-${Date.now()}`;
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId,
        providerShipmentId,
        trackingNumber,
        status: 'LOST',
      }),
    );

    const dbShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(dbShipment.status).toBe(ShipmentStatus.LOST);

    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(invBefore.onHand);
    expect(invAfter.committed).toBe(invBefore.committed);
  });

  // ─── 11. Reconciliation Service API & Audit (Scenario J) ─────────────────────

  it('operator reconciles flagged shipment via ShippingReconciliationService and records audit log', async () => {
    const { shipment, providerShipmentId, trackingNumber } = await createOrderAndShipment(
      ShipmentStatus.IN_TRANSIT,
    );

    // Flag as reconciliationRequired via unknown event
    await postWebhook(
      'MOCK',
      createSignedRequest({
        eventId: `evt-recon-flag-${Date.now()}`,
        providerShipmentId,
        trackingNumber,
        status: 'UNRECOGNIZED_STATUS_XY',
      }),
    );

    const sFlagged = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(sFlagged.reconciliationRequired).toBe(true);

    // List flagged shipments via service
    const pendingList = await reconciliationService.listReconciliationQueue(adminActor, {});
    const inList = pendingList.data.some((s) => s.id === shipment.id);
    expect(inList).toBe(true);

    // Operator resolves the discrepancy: forces DELIVERED with note
    const resolvedShipment = await reconciliationService.reconcileShipment(
      shipment.id,
      adminActor,
      {
        targetStatus: ShipmentStatus.DELIVERED,
        notes: 'Courier delivery verified with customer via phone call',
      },
    );

    expect(resolvedShipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(resolvedShipment.reconciliationRequired).toBe(false);

    // AuditLog recorded for SHIPMENT_RECONCILED
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entityId: shipment.id,
        action: AuditAction.SHIPMENT_RECONCILED,
      },
    });
    expect(auditLogs.length).toBeGreaterThan(0);
    expect(auditLogs[0]?.reason).toContain('Courier delivery verified with customer');
  });

  it('rejects reconciliation attempt violating the canonical state machine with ConflictException', async () => {
    // 1. Try to regress DELIVERED back to PACKED
    const { shipment } = await createOrderAndShipment(ShipmentStatus.DELIVERED);

    await expect(
      reconciliationService.reconcileShipment(shipment.id, adminActor, {
        targetStatus: ShipmentStatus.PACKED,
        notes: 'Trying to force backward transition',
      }),
    ).rejects.toThrow(ConflictException);

    // 2. Try to transition terminal CANCELLED to DELIVERED
    const { shipment: cancelledShipment } = await createOrderAndShipment(ShipmentStatus.CANCELLED);

    await expect(
      reconciliationService.reconcileShipment(cancelledShipment.id, adminActor, {
        targetStatus: ShipmentStatus.DELIVERED,
        notes: 'Trying to reopen cancelled shipment',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('manually reconciling pre-dispatch PACKED shipment to DELIVERED routes inventory deduction through InventoryService', async () => {
    const { order, shipment } = await createOrderAndShipment(ShipmentStatus.PACKED);

    const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    const onHandBefore = invBefore.onHand;
    const committedBefore = invBefore.committed;

    // Operator manually resolves PACKED -> DELIVERED
    const resolved = await reconciliationService.reconcileShipment(shipment.id, adminActor, {
      targetStatus: ShipmentStatus.DELIVERED,
      notes: 'Customer physically received parcel directly at warehouse dock',
    });

    expect(resolved.status).toBe(ShipmentStatus.DELIVERED);
    expect(resolved.reconciliationRequired).toBe(false);

    // Physical inventory must be deducted through InventoryService
    const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: testVariantId },
    });
    expect(invAfter.onHand).toBe(onHandBefore - 2);
    expect(invAfter.committed).toBe(committedBefore - 2);

    // Inventory movement recorded
    const movement = await prisma.inventoryMovement.findUnique({
      where: { idempotencyKey: `shp_ship_${shipment.id}_${testVariantId}` },
    });
    expect(movement).toBeDefined();
    expect(movement?.type).toBe(InventoryMovementType.ORDER_SHIPPED);

    // Order marked DELIVERED
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe(OrderStatus.DELIVERED);
  });

  it('rejects reconciliation attempt when caller lacks SHIPPING_RECONCILE permission', async () => {
    const { shipment } = await createOrderAndShipment(ShipmentStatus.IN_TRANSIT);

    const unauthActor: MinimalUser = {
      id: 'unauth-operator-uuid',
      role: UserRole.STAFF,
      email: 'staff@vishkaraa.local',
    };

    // Temporarily restore permission check to reject
    const originalCan = permissionsService.can;
    permissionsService.can = async (_user, perm) => perm !== Permissions.SHIPPING_RECONCILE;

    try {
      await expect(
        reconciliationService.reconcileShipment(shipment.id, unauthActor, {
          targetStatus: ShipmentStatus.DELIVERED,
          notes: 'Unauthorized attempt',
        }),
      ).rejects.toThrow(ForbiddenException);
    } finally {
      permissionsService.can = originalCan;
    }
  });
});
