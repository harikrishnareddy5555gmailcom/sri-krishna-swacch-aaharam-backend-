import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FeatureKey,
  FeatureStatus,
  FeatureCategory,
  Permissions,
  UserRole,
  ShipmentStatus as TypeShipmentStatus,
} from '@vishkaraa/types';
import {
  FEATURE_REGISTRY,
  PERMISSION_REGISTRY,
  DEFAULT_ROLE_PERMISSIONS,
  validateFeatureDependencies,
} from '@vishkaraa/shared';
import { PrismaClient, ShipmentStatus as PrismaShipmentStatus } from '@prisma/client';

describe('Phase 13B.1 — Shipping & Fulfillment Domain Foundation', () => {
  let prisma: PrismaClient;

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
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ===========================================================================
  // 1. DOMAIN ENUMS & REGISTRY INTEGRITY
  // ===========================================================================
  describe('Domain Enums & Registry', () => {
    const expectedStatuses = [
      'CREATED',
      'PACKING',
      'PACKED',
      'READY_TO_SHIP',
      'SHIPPED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'DELIVERY_FAILED',
      'RTO_INITIATED',
      'RTO_DELIVERED',
      'CANCELLED',
      'LOST',
    ];

    it('should define all 13 canonical shipment states in @vishkaraa/types', () => {
      const typeStatuses = Object.values(TypeShipmentStatus);
      expect(typeStatuses).toHaveLength(13);
      for (const status of expectedStatuses) {
        expect(typeStatuses).toContain(status);
      }
    });

    it('should match Prisma ShipmentStatus enum with domain enum', () => {
      const prismaStatuses = Object.values(PrismaShipmentStatus);
      expect(prismaStatuses).toHaveLength(13);
      for (const status of expectedStatuses) {
        expect(prismaStatuses).toContain(status);
      }
    });

    it('should register FeatureKey.SHIPPING in central FEATURE_REGISTRY', () => {
      const feat = FEATURE_REGISTRY[FeatureKey.SHIPPING];
      expect(feat).toBeDefined();
      expect(feat.id).toBe('feat-shipping');
      expect(feat.key).toBe(FeatureKey.SHIPPING);
      expect(feat.name).toBe('Shipping & Fulfillment');
      expect(feat.status).toBe(FeatureStatus.ACTIVE);
      expect(feat.category).toBe(FeatureCategory.OPERATIONS);
      expect(feat.defaultEnabled).toBe(true);
      expect(feat.dependencies).toEqual([FeatureKey.ORDERS, FeatureKey.INVENTORY]);
      expect(feat.navigation).toBeDefined();
      expect(feat.navigation.path).toBe('/admin/shipping');
      expect(feat.navigation.showInNav).toBe(true);
      expect(feat.navigation.icon).toBe('truck');
    });

    it('should validate feature dependencies for SHIPPING correctly', () => {
      // Both active
      const allActive = (_key: FeatureKey) => true;
      const resActive = validateFeatureDependencies(FeatureKey.SHIPPING, allActive);
      expect(resActive.valid).toBe(true);
      expect(resActive.unmetDependencies).toHaveLength(0);

      // Orders inactive
      const ordersInactive = (key: FeatureKey) => key !== FeatureKey.ORDERS;
      const resOrdersInactive = validateFeatureDependencies(FeatureKey.SHIPPING, ordersInactive);
      expect(resOrdersInactive.valid).toBe(false);
      expect(resOrdersInactive.unmetDependencies).toContain(FeatureKey.ORDERS);

      // Inventory inactive
      const invInactive = (key: FeatureKey) => key !== FeatureKey.INVENTORY;
      const resInvInactive = validateFeatureDependencies(FeatureKey.SHIPPING, invInactive);
      expect(resInvInactive.valid).toBe(false);
      expect(resInvInactive.unmetDependencies).toContain(FeatureKey.INVENTORY);
    });

    it('should register all approved SHIPPING permissions in PERMISSION_REGISTRY', () => {
      const requiredPerms = [
        Permissions.SHIPPING_VIEW,
        Permissions.SHIPPING_CREATE,
        Permissions.SHIPPING_UPDATE,
        Permissions.SHIPPING_CANCEL,
        Permissions.SHIPPING_OVERRIDE,
        Permissions.SHIPPING_RECONCILE,
      ];

      for (const permKey of requiredPerms) {
        const def = PERMISSION_REGISTRY[permKey];
        expect(def, `Missing definition for ${permKey}`).toBeDefined();
        expect(def.key).toBe(permKey);
        expect(def.featureKey).toBe(FeatureKey.SHIPPING);
        expect(def.isAssignableToAdmin).toBe(true);
      }
    });

    it('should assign appropriate shipping permissions across roles', () => {
      // Super Admin: gets all
      const superAdminPerms = DEFAULT_ROLE_PERMISSIONS[UserRole.SUPER_ADMIN];
      expect(superAdminPerms).toContain(Permissions.SHIPPING_VIEW);
      expect(superAdminPerms).toContain(Permissions.SHIPPING_CREATE);
      expect(superAdminPerms).toContain(Permissions.SHIPPING_UPDATE);
      expect(superAdminPerms).toContain(Permissions.SHIPPING_CANCEL);
      expect(superAdminPerms).toContain(Permissions.SHIPPING_OVERRIDE);
      expect(superAdminPerms).toContain(Permissions.SHIPPING_RECONCILE);

      // Admin baseline: operational permissions (excluding break-glass override)
      const adminPerms = DEFAULT_ROLE_PERMISSIONS[UserRole.ADMIN];
      expect(adminPerms).toContain(Permissions.SHIPPING_VIEW);
      expect(adminPerms).toContain(Permissions.SHIPPING_CREATE);
      expect(adminPerms).toContain(Permissions.SHIPPING_UPDATE);
      expect(adminPerms).toContain(Permissions.SHIPPING_CANCEL);
      expect(adminPerms).toContain(Permissions.SHIPPING_RECONCILE);
      expect(adminPerms).not.toContain(Permissions.SHIPPING_OVERRIDE);

      // User baseline: tracking view only
      const userPerms = DEFAULT_ROLE_PERMISSIONS[UserRole.USER];
      expect(userPerms).toContain(Permissions.SHIPPING_VIEW);
      expect(userPerms).not.toContain(Permissions.SHIPPING_CREATE);
      expect(userPerms).not.toContain(Permissions.SHIPPING_UPDATE);
      expect(userPerms).not.toContain(Permissions.SHIPPING_CANCEL);
    });
  });

  // ===========================================================================
  // 2. REAL POSTGRESQL DDL & MIGRATION VERIFICATION
  // ===========================================================================
  describe('PostgreSQL Schema & Tables', () => {
    it('should have ShipmentStatus enum in PostgreSQL with 13 labels', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(`
        SELECT enumlabel 
        FROM pg_enum 
        JOIN pg_type ON pg_enum.enumtypid = pg_type.oid 
        WHERE pg_type.typname = 'ShipmentStatus'
        ORDER BY enumsortorder;
      `);

      const labels = rows.map((r) => r.enumlabel);
      expect(labels).toHaveLength(13);
      expect(labels).toEqual([
        'CREATED',
        'PACKING',
        'PACKED',
        'READY_TO_SHIP',
        'SHIPPED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'DELIVERY_FAILED',
        'RTO_INITIATED',
        'RTO_DELIVERED',
        'CANCELLED',
        'LOST',
      ]);
    });

    it('should have all 4 Shipping tables in PostgreSQL', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('shipments', 'shipment_items', 'shipment_events', 'shipment_webhook_events')
        ORDER BY table_name;
      `);

      const tables = rows.map((r) => r.table_name);
      expect(tables).toEqual([
        'shipment_events',
        'shipment_items',
        'shipment_webhook_events',
        'shipments',
      ]);
    });

    it('should verify foreign key delete rules (RESTRICT vs CASCADE)', async () => {
      const fkRows = await prisma.$queryRawUnsafe<
        Array<{
          table_name: string;
          column_name: string;
          foreign_table_name: string;
          delete_rule: string;
        }>
      >(`
        SELECT
          tc.table_name,
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          rc.delete_rule
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.referential_constraints AS rc
          ON tc.constraint_name = rc.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.table_name IN ('shipments', 'shipment_items', 'shipment_events')
        ORDER BY tc.table_name, kcu.column_name;
      `);

      // shipments.orderId -> orders (RESTRICT)
      const orderFk = fkRows.find(
        (r) => r.table_name === 'shipments' && r.column_name === 'orderId',
      );
      expect(orderFk).toBeDefined();
      expect(orderFk?.foreign_table_name).toBe('orders');
      expect(orderFk?.delete_rule).toBe('RESTRICT');

      // shipments.userId -> users (RESTRICT)
      const userFk = fkRows.find(
        (r) => r.table_name === 'shipments' && r.column_name === 'userId',
      );
      expect(userFk).toBeDefined();
      expect(userFk?.foreign_table_name).toBe('users');
      expect(userFk?.delete_rule).toBe('RESTRICT');

      // shipment_items.shipmentId -> shipments (CASCADE)
      const itemShipmentFk = fkRows.find(
        (r) => r.table_name === 'shipment_items' && r.column_name === 'shipmentId',
      );
      expect(itemShipmentFk).toBeDefined();
      expect(itemShipmentFk?.foreign_table_name).toBe('shipments');
      expect(itemShipmentFk?.delete_rule).toBe('CASCADE');

      // shipment_items.orderItemId -> order_items (RESTRICT)
      const itemOrderItemFk = fkRows.find(
        (r) => r.table_name === 'shipment_items' && r.column_name === 'orderItemId',
      );
      expect(itemOrderItemFk).toBeDefined();
      expect(itemOrderItemFk?.foreign_table_name).toBe('order_items');
      expect(itemOrderItemFk?.delete_rule).toBe('RESTRICT');

      // shipment_events.shipmentId -> shipments (CASCADE)
      const eventShipmentFk = fkRows.find(
        (r) => r.table_name === 'shipment_events' && r.column_name === 'shipmentId',
      );
      expect(eventShipmentFk).toBeDefined();
      expect(eventShipmentFk?.foreign_table_name).toBe('shipments');
      expect(eventShipmentFk?.delete_rule).toBe('CASCADE');
    });
  });

  // ===========================================================================
  // 3. DATABASE INVARIANTS & CHECK CONSTRAINTS (REAL POSTGRESQL INSERT TESTS)
  // ===========================================================================
  describe('PostgreSQL Invariant & Constraint Enforcement', () => {
    let testUserId: string;
    let testOrderId: string;
    let testOrderItemId: string;
    let testVariantId: string;
    let testProductId: string;
    let testCategoryId: string;

    beforeAll(async () => {
      // Create isolated test fixture in DB
      const suffix = Math.random().toString(36).substring(2, 8);
      const user = await prisma.user.create({
        data: {
          email: `shipping-test-${suffix}@vishkaraa.local`,
          passwordHash: 'dummy-hash',
          firstName: 'Shipping',
          lastName: 'Tester',
          role: UserRole.USER,
        },
      });
      testUserId = user.id;

      const category = await prisma.category.create({
        data: {
          name: `Shipping Category ${suffix}`,
          slug: `shipping-cat-${suffix}`,
        },
      });
      testCategoryId = category.id;

      const product = await prisma.product.create({
        data: {
          categoryId: testCategoryId,
          name: `Shipping Test Product ${suffix}`,
          slug: `shipping-prod-${suffix}`,
          status: 'ACTIVE',
        },
      });
      testProductId = product.id;

      const variant = await prisma.productVariant.create({
        data: {
          productId: testProductId,
          name: '500ml',
          sku: `SKU-SHP-${suffix}`,
          price: 50000,
        },
      });
      testVariantId = variant.id;

      const checkout = await prisma.checkoutSession.create({
        data: {
          userId: testUserId,
          idempotencyKey: `chk-shp-${suffix}`,
          expiresAt: new Date(Date.now() + 3600000),
          subtotal: 50000,
          currency: 'INR',
        },
      });

      const payment = await prisma.paymentAttempt.create({
        data: {
          userId: testUserId,
          checkoutSessionId: checkout.id,
          amount: 50000,
          currency: 'INR',
          status: 'CAPTURED',
          provider: 'MOCK',
          idempotencyKey: `pay-shp-${suffix}`,
        },
      });

      const order = await prisma.order.create({
        data: {
          orderNumber: `VN-202610-SHP${suffix.toUpperCase()}`,
          userId: testUserId,
          checkoutSessionId: checkout.id,
          paymentAttemptId: payment.id,
          status: 'CONFIRMED',
          subtotal: 50000,
          totalAmount: 50000,
          currency: 'INR',
          shippingName: 'Shipping Tester',
          shippingPhone: '+919876543210',
          shippingLine1: '123 Herbal Way',
          shippingCity: 'Bengaluru',
          shippingState: 'Karnataka',
          shippingPostalCode: '560001',
          shippingCountry: 'IN',
        },
      });
      testOrderId = order.id;

      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: testOrderId,
          productId: testProductId,
          variantId: testVariantId,
          productName: 'Shipping Test Product',
          variantName: '500ml',
          productSku: `SKU-SHP-${suffix}`,
          quantity: 3,
          unitPrice: 50000,
          lineTotal: 150000,
          currency: 'INR',
        },
      });
      testOrderItemId = orderItem.id;
    });

    afterAll(async () => {
      // Clean up in reverse dependency order
      try {
        await prisma.shipmentEvent.deleteMany({ where: { shipment: { orderId: testOrderId } } });
        await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: testOrderId } } });
        await prisma.shipment.deleteMany({ where: { orderId: testOrderId } });
        await prisma.invoiceItem.deleteMany({ where: { invoice: { orderId: testOrderId } } });
        await prisma.invoice.deleteMany({ where: { orderId: testOrderId } });
        await prisma.auditLog.deleteMany({ where: { orderId: testOrderId } });
        await prisma.inventoryReservation.deleteMany({ where: { orderId: testOrderId } });
        await prisma.orderItem.deleteMany({ where: { orderId: testOrderId } });
        await prisma.order.deleteMany({ where: { id: testOrderId } });
        await prisma.paymentAttempt.deleteMany({ where: { userId: testUserId } });
        await prisma.checkoutSession.deleteMany({ where: { userId: testUserId } });
        await prisma.productVariant.deleteMany({ where: { id: testVariantId } });
        await prisma.product.deleteMany({ where: { id: testProductId } });
        await prisma.category.deleteMany({ where: { id: testCategoryId } });
        await prisma.user.deleteMany({ where: { id: testUserId } });
      } catch (err) {
        console.warn('Cleanup warning:', err);
      }
    });

    it('should create a valid Shipment and ShipmentItem successfully', async () => {
      const shpNumber = `SHP-202610-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      const shipment = await prisma.shipment.create({
        data: {
          shipmentNumber: shpNumber,
          orderId: testOrderId,
          userId: testUserId,
          carrierCode: 'SHIPROCKET',
          carrierName: 'Shiprocket Surface',
          trackingNumber: `TRK-${Math.random().toString(36).substring(2, 10)}`,
          weightGrams: 750,
          status: PrismaShipmentStatus.CREATED,
          items: {
            create: {
              orderItemId: testOrderItemId,
              variantId: testVariantId,
              productName: 'Shipping Test Product',
              productSku: 'SKU-SHP-TEST',
              quantity: 2,
            },
          },
          events: {
            create: {
              status: PrismaShipmentStatus.CREATED,
              description: 'Shipment created and queued for packing',
              eventTimestamp: new Date(),
            },
          },
        },
        include: {
          items: true,
          events: true,
        },
      });

      expect(shipment).toBeDefined();
      expect(shipment.shipmentNumber).toBe(shpNumber);
      expect(shipment.items).toHaveLength(1);
      expect(shipment.items[0]?.quantity).toBe(2);
      expect(shipment.events).toHaveLength(1);
      expect(shipment.events[0]?.status).toBe('CREATED');
    });

    it('should reject non-positive quantity in shipment_items (chk_shipment_item_quantity_positive)', async () => {
      const shpNumber = `SHP-202610-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      const shipment = await prisma.shipment.create({
        data: {
          shipmentNumber: shpNumber,
          orderId: testOrderId,
          userId: testUserId,
          carrierCode: 'MANUAL',
          carrierName: 'Direct Delivery',
        },
      });

      // Quantity = 0 must fail
      await expect(
        prisma.shipmentItem.create({
          data: {
            shipmentId: shipment.id,
            orderItemId: testOrderItemId,
            variantId: testVariantId,
            productName: 'Shipping Test Product',
            productSku: 'SKU-SHP-TEST',
            quantity: 0,
          },
        }),
      ).rejects.toThrow();

      // Quantity = -1 must fail
      await expect(
        prisma.shipmentItem.create({
          data: {
            shipmentId: shipment.id,
            orderItemId: testOrderItemId,
            variantId: testVariantId,
            productName: 'Shipping Test Product',
            productSku: 'SKU-SHP-TEST',
            quantity: -1,
          },
        }),
      ).rejects.toThrow();
    });

    it('should reject negative weight in shipments (chk_shipment_weight_non_negative)', async () => {
      const shpNumber = `SHP-202610-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      await expect(
        prisma.shipment.create({
          data: {
            shipmentNumber: shpNumber,
            orderId: testOrderId,
            userId: testUserId,
            carrierCode: 'MANUAL',
            carrierName: 'Direct Delivery',
            weightGrams: -50,
          },
        }),
      ).rejects.toThrow();
    });

    it('should reject negative codAmountPaise in shipments (chk_shipment_cod_amount_non_negative)', async () => {
      const shpNumber = `SHP-202610-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      await expect(
        prisma.shipment.create({
          data: {
            shipmentNumber: shpNumber,
            orderId: testOrderId,
            userId: testUserId,
            carrierCode: 'MANUAL',
            carrierName: 'Direct Delivery',
            isCod: true,
            codAmountPaise: -1000,
          },
        }),
      ).rejects.toThrow();
    });

    it('should enforce unique (provider, eventId) in shipment_webhook_events', async () => {
      const eventId = `evt-${Math.random().toString(36).substring(2, 10)}`;
      await prisma.shipmentWebhookEvent.create({
        data: {
          provider: 'SHIPROCKET',
          eventId,
          eventType: 'shipment.delivered',
          rawPayload: { test: true },
        },
      });

      // Duplicate must fail
      await expect(
        prisma.shipmentWebhookEvent.create({
          data: {
            provider: 'SHIPROCKET',
            eventId,
            eventType: 'shipment.delivered',
            rawPayload: { test: true, duplicate: true },
          },
        }),
      ).rejects.toThrow();
    });

    it('should enforce unique (carrierCode, trackingNumber) in shipments', async () => {
      const trackingNumber = `AWB-${Math.random().toString(36).substring(2, 12)}`;
      const shp1 = `SHP-202610-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      const shp2 = `SHP-202610-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

      await prisma.shipment.create({
        data: {
          shipmentNumber: shp1,
          orderId: testOrderId,
          userId: testUserId,
          carrierCode: 'DELHIVERY',
          carrierName: 'Delhivery Surface',
          trackingNumber,
        },
      });

      // Same carrier with same tracking number must fail
      await expect(
        prisma.shipment.create({
          data: {
            shipmentNumber: shp2,
            orderId: testOrderId,
            userId: testUserId,
            carrierCode: 'DELHIVERY',
            carrierName: 'Delhivery Surface',
            trackingNumber,
          },
        }),
      ).rejects.toThrow();
    });

    it('should enforce unique (shipmentId, orderItemId) in shipment_items', async () => {
      const shpNumber = `SHP-202610-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      const shipment = await prisma.shipment.create({
        data: {
          shipmentNumber: shpNumber,
          orderId: testOrderId,
          userId: testUserId,
          carrierCode: 'BLUEDART',
          carrierName: 'Blue Dart Air',
        },
      });

      await prisma.shipmentItem.create({
        data: {
          shipmentId: shipment.id,
          orderItemId: testOrderItemId,
          variantId: testVariantId,
          productName: 'Shipping Test Product',
          productSku: 'SKU-SHP-TEST',
          quantity: 1,
        },
      });

      // Duplicate order item in same shipment package must fail
      await expect(
        prisma.shipmentItem.create({
          data: {
            shipmentId: shipment.id,
            orderItemId: testOrderItemId,
            variantId: testVariantId,
            productName: 'Shipping Test Product',
            productSku: 'SKU-SHP-TEST',
            quantity: 1,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
