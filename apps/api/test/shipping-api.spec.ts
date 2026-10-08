import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  ShipmentStatus,
  OrderStatus,
  InventoryMovementType,
} from '@prisma/client';
import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, Permissions } from '@vishkaraa/types';
import { ShipmentService } from '../src/shipping/shipping.service.js';
import { ShippingReconciliationService } from '../src/shipping/reconciliation/shipping-reconciliation.service.js';
import { CustomerShipmentsController } from '../src/shipping/customer-shipments.controller.js';
import { AdminShipmentsController } from '../src/shipping/admin-shipments.controller.js';
import { ShippingWebhookService } from '../src/shipping/webhook/shipping-webhook.service.js';
import { ShippingProviderRegistry } from '../src/shipping/providers/shipping-provider.registry.js';
import { MockShippingProvider } from '../src/shipping/providers/mock/mock-shipping.provider.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import type { Request } from 'express';

describe('Phase 13B.4 — Shipping Customer & Admin APIs Integration & Security Tests', () => {
  let prisma: PrismaClient;
  let auditService: AuditService;
  let permissionsService: PermissionsService;
  let inventoryService: InventoryService;
  let shipmentService: ShipmentService;
  let reconciliationService: ShippingReconciliationService;
  let customerController: CustomerShipmentsController;
  let adminController: AdminShipmentsController;
  let mockProvider: MockShippingProvider;
  let webhookService: ShippingWebhookService;

  const testSecret = 'mock-shipping-webhook-secret-min-32-chars-long';

  // Actor identities
  let superAdminActor: MinimalUser;
  let adminFullActor: MinimalUser;
  let adminViewOnlyActor: MinimalUser;
  let adminNoPermsActor: MinimalUser;
  let customerOneActor: MinimalUser;
  let customerTwoActor: MinimalUser;

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
    reconciliationService = new ShippingReconciliationService(
      shipmentService,
      permissionsService,
    );
    mockProvider = new MockShippingProvider(testSecret);
    const registry = new ShippingProviderRegistry(mockProvider);
    webhookService = new ShippingWebhookService(prisma as any, registry, shipmentService);

    customerController = new CustomerShipmentsController(shipmentService);
    adminController = new AdminShipmentsController(
      shipmentService,
      reconciliationService,
    );

    // Seed test users
    const suffix = Math.random().toString(36).substring(2, 8);

    const superAdmin = await prisma.user.create({
      data: {
        email: `shp_superadmin_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Super',
        lastName: 'Admin',
        role: UserRole.SUPER_ADMIN,
      },
    });
    superAdminActor = {
      id: superAdmin.id,
      role: UserRole.SUPER_ADMIN,
      email: superAdmin.email,
    };

    const adminFull = await prisma.user.create({
      data: {
        email: `shp_adminfull_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Admin',
        lastName: 'Full',
        role: UserRole.ADMIN,
      },
    });
    adminFullActor = {
      id: adminFull.id,
      role: UserRole.ADMIN,
      email: adminFull.email,
    };

    const adminView = await prisma.user.create({
      data: {
        email: `shp_adminview_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Admin',
        lastName: 'View',
        role: UserRole.ADMIN,
      },
    });
    adminViewOnlyActor = {
      id: adminView.id,
      role: UserRole.ADMIN,
      email: adminView.email,
    };

    const adminNoPerms = await prisma.user.create({
      data: {
        email: `shp_adminnoperms_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Admin',
        lastName: 'NoPerms',
        role: UserRole.ADMIN,
      },
    });
    adminNoPermsActor = {
      id: adminNoPerms.id,
      role: UserRole.ADMIN,
      email: adminNoPerms.email,
    };

    const customerOne = await prisma.user.create({
      data: {
        email: `shp_custone_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Customer',
        lastName: 'One',
        role: UserRole.USER,
      },
    });
    customerOneActor = {
      id: customerOne.id,
      role: UserRole.USER,
      email: customerOne.email,
    };

    const customerTwo = await prisma.user.create({
      data: {
        email: `shp_custtwo_${suffix}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Customer',
        lastName: 'Two',
        role: UserRole.USER,
      },
    });
    customerTwoActor = {
      id: customerTwo.id,
      role: UserRole.USER,
      email: customerTwo.email,
    };

    // Configure permissions service behavior for test actors
    permissionsService.can = async (user, perm) => {
      if (user.role === UserRole.SUPER_ADMIN) return true;
      if (user.id === adminFullActor.id) return true;
      if (user.id === adminViewOnlyActor.id) {
        return perm === Permissions.SHIPPING_VIEW;
      }
      return false;
    };

    // Seed catalog fixtures
    const category = await prisma.category.create({
      data: {
        name: `API Cat ${suffix}`,
        slug: `api-cat-${suffix}`,
      },
    });
    testCategoryId = category.id;

    const product = await prisma.product.create({
      data: {
        name: `API Product ${suffix}`,
        slug: `api-prod-${suffix}`,
        categoryId: testCategoryId,
        status: 'ACTIVE',
      },
    });
    testProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: testProductId,
        name: '500ml',
        sku: `SKU-API-${suffix}`,
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

  function mockRequest(user: MinimalUser): Request {
    return { user } as unknown as Request;
  }

  async function createOrder(
    user: MinimalUser,
    quantity: number = 2,
  ) {
    const sfx = Math.random().toString(36).substring(2, 8);

    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        idempotencyKey: `chk-api-${sfx}`,
        expiresAt: new Date(Date.now() + 3600000),
        subtotal: 49900 * quantity,
        currency: 'INR',
      },
    });

    const payment = await prisma.paymentAttempt.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        amount: 49900 * quantity,
        currency: 'INR',
        status: 'CAPTURED',
        provider: 'MOCK',
        idempotencyKey: `pay-api-${sfx}`,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-API-${sfx.toUpperCase()}`,
        userId: user.id,
        checkoutSessionId: checkout.id,
        paymentAttemptId: payment.id,
        status: OrderStatus.CONFIRMED,
        subtotal: 49900 * quantity,
        totalAmount: 49900 * quantity,
        currency: 'INR',
        items: {
          create: [
            {
              productId: testProductId,
              variantId: testVariantId,
              productName: 'Herbal Shampoo',
              variantName: '500ml',
              productSku: `SKU-API-${sfx}`,
              quantity,
              unitPrice: 49900,
              lineTotal: 49900 * quantity,
            },
          ],
        },
      },
      include: { items: true },
    });

    // Commit inventory
    await prisma.inventoryItem.update({
      where: { variantId: testVariantId },
      data: { committed: { increment: quantity } },
    });

    return order;
  }

  async function createOrderAndShipment(
    user: MinimalUser,
    initialStatus: ShipmentStatus = ShipmentStatus.PACKED,
  ) {
    const order = await createOrder(user, 2);
    const orderItem = order.items[0];

    const shipment = await shipmentService.createShipment(adminFullActor, {
      orderId: order.id,
      carrierCode: 'SHIPROCKET',
      carrierName: 'Shiprocket Express',
      serviceType: 'EXPRESS',
      trackingNumber: `SR-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
      labelUrl: 'https://shiprocket.co/tracking/SR-12345',
      items: [
        {
          orderItemId: orderItem.id,
          quantity: 2,
        },
      ],
    });

    if (initialStatus !== ShipmentStatus.CREATED) {
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          status: initialStatus,
          reconciliationNotes: 'Internal warehouse verification note',
          reconciliationRequired: initialStatus === ShipmentStatus.DELIVERY_FAILED,
        },
      });
    }

    return { order, orderItem, shipmentId: shipment.id };
  }

  // ===========================================================================
  // SECTION 9: SECURITY / IDOR TESTS
  // ===========================================================================

  describe('9. Security & IDOR Enforcement', () => {
    it('A. User can read own shipment for own order', async () => {
      const { order, shipmentId } = await createOrderAndShipment(customerOneActor);

      const req = mockRequest(customerOneActor);
      const shipments = await customerController.listOrderShipments(req, order.id);

      expect(shipments).toHaveLength(1);
      expect(shipments[0]?.id).toBe(shipmentId);
      expect(shipments[0]?.orderId).toBe(order.id);

      const single = await customerController.getOrderShipmentById(req, order.id, shipmentId);
      expect(single.id).toBe(shipmentId);
      expect(single.orderId).toBe(order.id);
    });

    it('B. User cannot read another user shipment (403 Forbidden)', async () => {
      const { order, shipmentId } = await createOrderAndShipment(customerOneActor);

      // Customer Two attempts to access Customer One's order
      const req = mockRequest(customerTwoActor);

      await expect(
        customerController.listOrderShipments(req, order.id),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        customerController.getOrderShipmentById(req, order.id, shipmentId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('C. User cannot access another user order shipment through manipulated IDs (IDOR protection)', async () => {
      const { order: orderOne } = await createOrderAndShipment(customerOneActor);
      const { shipmentId: shipmentTwoId } = await createOrderAndShipment(customerTwoActor);

      // Customer One provides their own valid orderOne.id, but injects shipmentTwoId
      const req = mockRequest(customerOneActor);

      await expect(
        customerController.getOrderShipmentById(req, orderOne.id, shipmentTwoId),
      ).rejects.toThrow(NotFoundException);
    });

    it('D. User cannot call admin shipment APIs (ForbiddenException)', async () => {
      const { shipmentId } = await createOrderAndShipment(customerOneActor);
      const req = mockRequest(customerOneActor);

      await expect(adminController.listShipments(req, {})).rejects.toThrow(
        ForbiddenException,
      );

      await expect(adminController.getShipmentById(req, shipmentId)).rejects.toThrow(
        ForbiddenException,
      );

      await expect(
        adminController.createShipment(req, {
          orderId: 'some-order',
          items: [{ orderItemId: 'item-1', quantity: 1 }],
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        adminController.updateShipmentStatus(req, shipmentId, {
          status: ShipmentStatus.SHIPPED,
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        adminController.cancelShipment(req, shipmentId, { reason: 'Attacker cancel' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('E. Admin without SHIPPING.VIEW cannot list/detail', async () => {
      const { shipmentId } = await createOrderAndShipment(customerOneActor);
      const req = mockRequest(adminNoPermsActor);

      await expect(adminController.listShipments(req, {})).rejects.toThrow(
        ForbiddenException,
      );

      await expect(adminController.getShipmentById(req, shipmentId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('F. Admin without SHIPPING.CREATE cannot create shipment', async () => {
      const order = await createOrder(customerOneActor);
      const req = mockRequest(adminViewOnlyActor);

      await expect(
        adminController.createShipment(req, {
          orderId: order.id,
          items: [{ orderItemId: order.items[0].id, quantity: 1 }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('G. Admin without SHIPPING.UPDATE cannot change status', async () => {
      const { shipmentId } = await createOrderAndShipment(customerOneActor);
      const req = mockRequest(adminViewOnlyActor);

      await expect(
        adminController.updateShipmentStatus(req, shipmentId, {
          status: ShipmentStatus.READY_TO_SHIP,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('H. Admin without SHIPPING.CANCEL cannot cancel shipment', async () => {
      const { shipmentId } = await createOrderAndShipment(customerOneActor);
      const req = mockRequest(adminViewOnlyActor);

      await expect(
        adminController.cancelShipment(req, shipmentId, {
          reason: 'Unauthorized cancel attempt',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('I. Granted ADMIN permissions work for authorized actions', async () => {
      const { order, shipmentId } = await createOrderAndShipment(customerOneActor);
      const req = mockRequest(adminFullActor);

      // 1. List
      const listRes = await adminController.listShipments(req, { orderId: order.id });
      expect(listRes.data.length).toBeGreaterThanOrEqual(1);

      // 2. Detail
      const detail = await adminController.getShipmentById(req, shipmentId);
      expect(detail.id).toBe(shipmentId);

      // 3. Update Status
      const updated = await adminController.updateShipmentStatus(req, shipmentId, {
        status: ShipmentStatus.READY_TO_SHIP,
      });
      expect(updated.status).toBe(ShipmentStatus.READY_TO_SHIP);

      // 4. Cancel
      const cancelled = await adminController.cancelShipment(req, shipmentId, {
        reason: 'Authorized admin cancellation',
      });
      expect(cancelled.status).toBe(ShipmentStatus.CANCELLED);
    });

    it('J. SUPER_ADMIN has full access to all endpoints without explicit grants', async () => {
      const { order, shipmentId } = await createOrderAndShipment(customerOneActor);
      const req = mockRequest(superAdminActor);

      const listRes = await adminController.listShipments(req, { orderId: order.id });
      expect(listRes.data).toBeDefined();

      const detail = await adminController.getShipmentById(req, shipmentId);
      expect(detail.id).toBe(shipmentId);

      const updated = await adminController.updateShipmentStatus(req, shipmentId, {
        status: ShipmentStatus.READY_TO_SHIP,
      });
      expect(updated.status).toBe(ShipmentStatus.READY_TO_SHIP);
    });

    it('K. Reconciliation endpoint remains SHIPPING.RECONCILE-only', async () => {
      const { shipmentId } = await createOrderAndShipment(
        customerOneActor,
        ShipmentStatus.IN_TRANSIT,
      );

      // Flag shipment for reconciliation
      await prisma.shipment.update({
        where: { id: shipmentId },
        data: { reconciliationRequired: true, reconciliationNotes: 'Test discrep' },
      });

      // 1. Admin without SHIPPING_RECONCILE is rejected
      const reqViewOnly = mockRequest(adminViewOnlyActor);
      await expect(
        adminController.listReconciliationQueue(reqViewOnly, {}),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        adminController.reconcileShipment(reqViewOnly, shipmentId, {
          targetStatus: ShipmentStatus.DELIVERED,
          notes: 'Unauthorized reconcile',
        }),
      ).rejects.toThrow(ForbiddenException);

      // 2. Full Admin with SHIPPING_RECONCILE succeeds
      const reqFull = mockRequest(adminFullActor);
      const queue = await adminController.listReconciliationQueue(reqFull, {});
      expect(queue.data.some((s) => s.id === shipmentId)).toBe(true);

      const resolved = await adminController.reconcileShipment(reqFull, shipmentId, {
        targetStatus: ShipmentStatus.DELIVERED,
        notes: 'Verified with customer',
      });
      expect(resolved.status).toBe(ShipmentStatus.DELIVERED);
      expect(resolved.reconciliationRequired).toBe(false);
    });

    it('L. Customer response boundary does not expose internal fields or unvalidated URLs', async () => {
      const { order, shipmentId } = await createOrderAndShipment(customerOneActor);

      // Store an unsafe/unapproved tracking URL and internal reconciliation notes
      await prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          labelUrl: 'http://insecure-thirdparty.com/track/123',
          reconciliationRequired: true,
          reconciliationNotes: 'CONFIDENTIAL: carrier suspicious activity notes',
        },
      });

      const req = mockRequest(customerOneActor);
      const res = await customerController.getOrderShipmentById(req, order.id, shipmentId);

      // Safe fields present
      expect(res.id).toBe(shipmentId);
      expect(res.shipmentNumber).toBeDefined();
      expect(res.carrierName).toBe('Shiprocket Express');
      expect(res.items).toHaveLength(1);

      // Insecure URL MUST be sanitized to null
      expect(res.trackingUrl).toBeNull();

      // Internal fields MUST NOT exist on response
      const raw = res as Record<string, unknown>;
      expect(raw['reconciliationNotes']).toBeUndefined();
      expect(raw['reconciliationRequired']).toBeUndefined();
      expect(raw['rawPayload']).toBeUndefined();
      expect(raw['version']).toBeUndefined();
      expect(raw['userId']).toBeUndefined();
      expect(raw['providerShipmentId']).toBeUndefined();
      expect(raw['invoiceId']).toBeUndefined();
      expect(raw['manifestUrl']).toBeUndefined();
    });

    it('M. Admin response does not expose provider secrets or raw webhook payloads', async () => {
      const { shipmentId } = await createOrderAndShipment(customerOneActor);

      // Add a shipment event with simulated raw webhook payload containing API secret
      await prisma.shipmentEvent.create({
        data: {
          shipmentId,
          status: ShipmentStatus.IN_TRANSIT,
          description: 'Carrier hub scan',
          eventTimestamp: new Date(),
          rawPayload: {
            carrierApiKey: 'super-secret-key-12345',
            internalWebhookSignature: 'sig-abc-123',
            hubLocation: 'Bengaluru Central',
          },
        },
      });

      const req = mockRequest(adminFullActor);
      const adminDetail = await adminController.getShipmentById(req, shipmentId);

      expect(adminDetail.events).toBeDefined();
      expect(adminDetail.events?.length).toBeGreaterThanOrEqual(1);

      // Verify no event contains rawPayload
      for (const event of adminDetail.events || []) {
        const rawEvent = event as Record<string, unknown>;
        expect(rawEvent['rawPayload']).toBeUndefined();
        expect(JSON.stringify(event)).not.toContain('super-secret-key-12345');
      }
    });
  });

  // ===========================================================================
  // SECTION 10: CONCURRENCY & BUSINESS SAFETY
  // ===========================================================================

  describe('10. Concurrency & Business Safety', () => {
    it('handles Admin status update racing Webhook dispatch safely without double inventory deduction', async () => {
      const { shipmentId } = await createOrderAndShipment(
        customerOneActor,
        ShipmentStatus.READY_TO_SHIP,
      );

      const dbShipmentBefore = await prisma.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
      });
      const trackingNumber = dbShipmentBefore.trackingNumber!;

      const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
        where: { variantId: testVariantId },
      });

      const eventId = `evt-race-admin-wh-${Date.now()}`;
      const webhookBuffer = Buffer.from(
        JSON.stringify({
          eventId,
          providerShipmentId: dbShipmentBefore.providerShipmentId,
          trackingNumber,
          status: 'PICKED_UP',
          eventTimestamp: new Date().toISOString(),
        }),
        'utf8',
      );
      const signature = MockShippingProvider.generateSignature(webhookBuffer, testSecret);

      const adminPromise = adminController.updateShipmentStatus(
        mockRequest(adminFullActor),
        shipmentId,
        {
          status: ShipmentStatus.SHIPPED,
        },
      );

      const webhookPromise = webhookService.processWebhook(
        'MOCK',
        webhookBuffer,
        { 'x-mock-signature': signature },
      );

      const [adminRes, webhookRes] = await Promise.allSettled([
        adminPromise,
        webhookPromise,
      ]);

      expect(adminRes.status).toBe('fulfilled');
      expect(webhookRes.status).toBe('fulfilled');

      // Final status is SHIPPED
      const dbShipmentAfter = await prisma.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
      });
      expect(dbShipmentAfter.status).toBe(ShipmentStatus.SHIPPED);

      // Inventory deducted EXACTLY once (2 items)
      const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
        where: { variantId: testVariantId },
      });
      expect(invAfter.onHand).toBe(invBefore.onHand - 2);
      expect(invAfter.committed).toBe(invBefore.committed - 2);

      // Single inventory movement
      const movements = await prisma.inventoryMovement.findMany({
        where: { idempotencyKey: `shp_ship_${shipmentId}_${testVariantId}` },
      });
      expect(movements).toHaveLength(1);
    });

    it('handles Admin cancel racing Webhook dispatch deterministically', async () => {
      const { shipmentId } = await createOrderAndShipment(
        customerOneActor,
        ShipmentStatus.READY_TO_SHIP,
      );

      const dbShipmentBefore = await prisma.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
      });
      const trackingNumber = dbShipmentBefore.trackingNumber!;

      const invBefore = await prisma.inventoryItem.findUniqueOrThrow({
        where: { variantId: testVariantId },
      });

      const eventId = `evt-race-admin-cancel-wh-${Date.now()}`;
      const webhookBuffer = Buffer.from(
        JSON.stringify({
          eventId,
          providerShipmentId: dbShipmentBefore.providerShipmentId,
          trackingNumber,
          status: 'PICKED_UP',
          eventTimestamp: new Date().toISOString(),
        }),
        'utf8',
      );
      const signature = MockShippingProvider.generateSignature(webhookBuffer, testSecret);

      const cancelPromise = adminController.cancelShipment(
        mockRequest(adminFullActor),
        shipmentId,
        {
          reason: 'Customer cancelled prior to pickup',
        },
      );

      const webhookPromise = webhookService.processWebhook(
        'MOCK',
        webhookBuffer,
        { 'x-mock-signature': signature },
      );

      const [cancelRes, webhookRes] = await Promise.allSettled([
        cancelPromise,
        webhookPromise,
      ]);

      const dbShipmentAfter = await prisma.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
      });
      const invAfter = await prisma.inventoryItem.findUniqueOrThrow({
        where: { variantId: testVariantId },
      });

      if (dbShipmentAfter.status === ShipmentStatus.CANCELLED) {
        expect(cancelRes.status).toBe('fulfilled');
        expect(invAfter.onHand).toBe(invBefore.onHand);
        expect(dbShipmentAfter.reconciliationRequired).toBe(true);
      } else {
        expect(dbShipmentAfter.status).toBe(ShipmentStatus.SHIPPED);
        expect(cancelRes.status).toBe('rejected');
        expect(invAfter.onHand).toBe(invBefore.onHand - 2);
      }
    });

    it('handles concurrent Admin status updates safely under database row locking', async () => {
      const { shipmentId } = await createOrderAndShipment(
        customerOneActor,
        ShipmentStatus.READY_TO_SHIP,
      );

      // Two admins try to update the shipment status concurrently
      const promise1 = adminController.updateShipmentStatus(
        mockRequest(adminFullActor),
        shipmentId,
        { status: ShipmentStatus.SHIPPED },
      );

      const promise2 = adminController.updateShipmentStatus(
        mockRequest(adminFullActor),
        shipmentId,
        { status: ShipmentStatus.SHIPPED },
      );

      const [res1, res2] = await Promise.allSettled([promise1, promise2]);

      expect(res1.status).toBe('fulfilled');
      expect(res2.status).toBe('fulfilled');

      const dbShipment = await prisma.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
      });
      expect(dbShipment.status).toBe(ShipmentStatus.SHIPPED);
    });

    it('prevents over-allocation when concurrent admin shipment creations race for the same order items', async () => {
      const order = await createOrder(customerOneActor, 2);
      const orderItem = order.items[0];

      // Two concurrent shipment creation requests each asking for the full 2 units
      const create1 = adminController.createShipment(
        mockRequest(adminFullActor),
        {
          orderId: order.id,
          carrierCode: 'SHIPROCKET',
          items: [{ orderItemId: orderItem.id, quantity: 2 }],
        },
      );

      const create2 = adminController.createShipment(
        mockRequest(adminFullActor),
        {
          orderId: order.id,
          carrierCode: 'SHIPROCKET',
          items: [{ orderItemId: orderItem.id, quantity: 2 }],
        },
      );

      const [res1, res2] = await Promise.allSettled([create1, create2]);

      // Exactly one must succeed, the other must be rejected with ConflictException
      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      if (rejected[0].status === 'rejected') {
        expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      }

      // Total allocated quantity across all shipments for this order item must be exactly 2 (never 4)
      const allocatedRows = await prisma.shipmentItem.findMany({
        where: { orderItemId: orderItem.id },
      });
      const totalAllocated = allocatedRows.reduce((sum, item) => sum + item.quantity, 0);
      expect(totalAllocated).toBe(2);
    });
  });

  // ===========================================================================
  // SECTION 11: API ERROR CONTRACT & PAGINATION
  // ===========================================================================

  describe('11. API Error Contract & Pagination', () => {
    it('returns bounded pagination and filters on admin list', async () => {
      const req = mockRequest(adminFullActor);

      // Create 3 shipments
      await createOrderAndShipment(customerOneActor);
      await createOrderAndShipment(customerOneActor);
      await createOrderAndShipment(customerOneActor);

      const list1 = await adminController.listShipments(req, {
        page: 1,
        limit: 2,
      });

      expect(list1.data.length).toBeLessThanOrEqual(2);
      expect(list1.page).toBe(1);
      expect(list1.limit).toBe(2);
      expect(list1.total).toBeGreaterThanOrEqual(3);

      // Clamps limit > 100 to 100
      const listClamped = await adminController.listShipments(req, {
        page: 1,
        limit: 500,
      });
      expect(listClamped.limit).toBe(100);
    });

    it('rejects invalid status transitions with ConflictException', async () => {
      const { shipmentId } = await createOrderAndShipment(
        customerOneActor,
        ShipmentStatus.DELIVERED,
      );

      // Attempt impossible transition: DELIVERED -> PACKED
      await expect(
        adminController.updateShipmentStatus(mockRequest(adminFullActor), shipmentId, {
          status: ShipmentStatus.PACKED,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects cancellation on post-dispatch shipment with ConflictException or BadRequestException', async () => {
      const { shipmentId } = await createOrderAndShipment(
        customerOneActor,
        ShipmentStatus.SHIPPED,
      );

      await expect(
        adminController.cancelShipment(mockRequest(adminFullActor), shipmentId, {
          reason: 'Cancel after shipped',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
