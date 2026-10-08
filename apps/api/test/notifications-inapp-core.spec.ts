import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationEventType,
  DeliveryStatus,
} from '@vishkaraa/types';
import { PrismaClient, Prisma } from '@prisma/client';
import { NotificationService } from '../src/notifications/notification.service.js';
import { NotificationTemplateRegistry } from '../src/notifications/templates/notification-template.registry.js';
import { BUILTIN_TEMPLATES } from '../src/notifications/templates/definitions/index.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { ForbiddenException } from '@nestjs/common';

describe('Phase 14D — Basic In-App Notification Center Core', () => {
  let prisma: PrismaClient;
  let templateRegistry: NotificationTemplateRegistry;
  let notificationService: NotificationService;
  const testRunId = Math.random().toString(36).substring(2, 8);

  let testUser1: { id: string; email: string };
  let testUser2: { id: string; email: string };

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

    // Initialize code-managed template registry (built-in templates are registered in constructor)
    templateRegistry = new NotificationTemplateRegistry();

    notificationService = new NotificationService(
      prisma as unknown as PrismaService,
      templateRegistry,
    );

    // Create test users
    testUser1 = await prisma.user.create({
      data: {
        email: `notif-user1-${testRunId}@example.com`,
        passwordHash: 'dummy-hash',
        firstName: 'Test',
        lastName: 'Customer One',
        role: 'USER',
      },
      select: { id: true, email: true },
    });

    testUser2 = await prisma.user.create({
      data: {
        email: `notif-user2-${testRunId}@example.com`,
        passwordHash: 'dummy-hash',
        firstName: 'Test',
        lastName: 'Customer Two',
        role: 'USER',
      },
      select: { id: true, email: true },
    });
  });

  afterAll(async () => {
    // Cleanup notifications and deliveries
    const userIds = [testUser1?.id, testUser2?.id].filter(Boolean) as string[];
    if (userIds.length > 0) {
      await prisma.notificationDelivery.deleteMany({
        where: {
          recipient: { in: userIds },
        },
      });
      await prisma.notification.deleteMany({
        where: {
          userId: { in: userIds },
        },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
    await prisma.$disconnect();
  });

  // ===========================================================================
  // 1. DOMAIN EVENTS IN-APP NOTIFICATION CREATION
  // ===========================================================================
  describe('1. Domain Events In-App Notification Creation', () => {
    it('1.1 ORDER_CONFIRMED creates exactly one in-app notification with DeliveryStatus.SENT', async () => {
      const orderId = `ord_${testRunId}_01`;
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.ORDER_CONFIRMED,
        entityType: 'order',
        entityId: orderId,
        context: {
          orderNumber: 'VN-ORD-1001',
          customerName: 'Test Customer',
          totalAmount: '1,499.00',
          orderDate: '2026-09-30',
        },
        actionUrl: `/orders/${orderId}`,
      });

      expect(notif).toBeDefined();
      expect(notif.userId).toBe(testUser1.id);
      expect(notif.type).toBe(NotificationEventType.ORDER_CONFIRMED);
      expect(notif.title).toContain('Order Confirmed');
      expect(notif.body).toContain('VN-ORD-1001');
      expect(notif.isRead).toBe(false);

      // Verify delivery record in PostgreSQL
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: notif.id },
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].channel).toBe(NotificationChannel.IN_APP);
      expect(deliveries[0].status).toBe(DeliveryStatus.SENT);
      expect(deliveries[0].lastAttemptAt).toBeInstanceOf(Date);
      expect(deliveries[0].idempotencyKey).toBe(`notif:order:${orderId}:ORDER_CONFIRMED:IN_APP`);
    });

    it('1.2 ORDER_CANCELLED creates one in-app notification', async () => {
      const orderId = `ord_${testRunId}_02`;
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.ORDER_CANCELLED,
        entityType: 'order',
        entityId: orderId,
        context: {
          orderNumber: 'VN-ORD-1002',
          customerName: 'Test Customer',
          reason: 'Customer requested cancellation',
        },
        actionUrl: `/orders/${orderId}`,
      });

      expect(notif.type).toBe(NotificationEventType.ORDER_CANCELLED);
      expect(notif.title).toContain('Order Cancelled');
      expect(notif.body).toContain('VN-ORD-1002');
      expect(notif.body).toContain('cancelled');
    });

    it('1.3 PAYMENT_CAPTURED creates one in-app notification', async () => {
      const paymentAttemptId = `pay_${testRunId}_01`;
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.PAYMENT_CAPTURED,
        entityType: 'payment',
        entityId: paymentAttemptId,
        context: {
          orderNumber: 'VN-ORD-1003',
          amount: '1499.00',
          paymentMethod: 'RAZORPAY',
        },
        actionUrl: `/orders/ord_1003`,
      });

      expect(notif.type).toBe(NotificationEventType.PAYMENT_CAPTURED);
      expect(notif.title).toContain('Payment Received');
      expect(notif.body).toContain('1499.00');
    });

    it('1.4 PAYMENT_FAILED creates one in-app notification', async () => {
      const paymentAttemptId = `pay_${testRunId}_02`;
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.PAYMENT_FAILED,
        entityType: 'payment',
        entityId: paymentAttemptId,
        context: {
          orderNumber: 'VN-ORD-1004',
          amount: '1499.00',
          failureReason: 'Card expired or insufficient balance',
          retryUrl: '/checkout',
        },
        actionUrl: '/checkout',
      });

      expect(notif.type).toBe(NotificationEventType.PAYMENT_FAILED);
      expect(notif.title).toContain('Payment Failed');
      expect(notif.body).toContain('1499.00');
    });

    it('1.5 SHIPMENT_DISPATCHED, OUT_FOR_DELIVERY, DELIVERED, and FAILED create in-app notifications', async () => {
      const shipmentId = `shp_${testRunId}_01`;

      // Dispatched
      const dispatched = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.SHIPMENT_DISPATCHED,
        entityType: 'shipment',
        entityId: shipmentId,
        context: {
          shipmentNumber: 'SHP-2026-001',
          orderNumber: 'VN-ORD-2001',
          carrierName: 'BlueDart Express',
          trackingNumber: 'BD123456789IN',
        },
        actionUrl: `/orders/ord_2001`,
      });
      expect(dispatched.type).toBe(NotificationEventType.SHIPMENT_DISPATCHED);
      expect(dispatched.body).toContain('BlueDart Express');

      // Out for delivery
      const outForDelivery = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.SHIPMENT_OUT_FOR_DELIVERY,
        entityType: 'shipment',
        entityId: shipmentId,
        context: {
          shipmentNumber: 'SHP-2026-001',
          orderNumber: 'VN-ORD-2001',
        },
        actionUrl: `/orders/ord_2001`,
      });
      expect(outForDelivery.type).toBe(NotificationEventType.SHIPMENT_OUT_FOR_DELIVERY);
      expect(outForDelivery.title).toContain('Out for Delivery');

      // Delivered
      const delivered = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.SHIPMENT_DELIVERED,
        entityType: 'shipment',
        entityId: shipmentId,
        context: {
          shipmentNumber: 'SHP-2026-001',
          orderNumber: 'VN-ORD-2001',
        },
        actionUrl: `/orders/ord_2001`,
      });
      expect(delivered.type).toBe(NotificationEventType.SHIPMENT_DELIVERED);
      expect(delivered.body).toContain('delivered');

      // Failed
      const failed = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.SHIPMENT_FAILED,
        entityType: 'shipment',
        entityId: shipmentId,
        context: {
          shipmentNumber: 'SHP-2026-001',
          orderNumber: 'VN-ORD-2001',
          reason: 'Customer address door locked',
        },
        actionUrl: `/orders/ord_2001`,
      });
      expect(failed.type).toBe(NotificationEventType.SHIPMENT_FAILED);
      expect(failed.body).toContain('door locked');
    });

    it('1.6 RETURN_APPROVED creates one in-app notification', async () => {
      const returnId = `ret_${testRunId}_01`;
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.RETURN_APPROVED,
        entityType: 'return',
        entityId: returnId,
        context: {
          returnNumber: 'RMA-2026-001',
          orderNumber: 'VN-ORD-3001',
        },
        actionUrl: `/orders/ord_3001`,
      });

      expect(notif.type).toBe(NotificationEventType.RETURN_APPROVED);
      expect(notif.title).toContain('Return Request Approved');
      expect(notif.body).toContain('RMA-2026-001');
    });

    it('1.7 REFUND_COMPLETED creates one in-app notification', async () => {
      const refundId = `ref_${testRunId}_01`;
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.REFUND_COMPLETED,
        entityType: 'refund',
        entityId: refundId,
        context: {
          refundNumber: 'RF-2026-001',
          orderNumber: 'VN-ORD-4001',
          amount: '750.00',
        },
        actionUrl: `/orders/ord_4001`,
      });

      expect(notif.type).toBe(NotificationEventType.REFUND_COMPLETED);
      expect(notif.title).toContain('Refund Processed');
      expect(notif.body).toContain('750.00');
    });

    it('1.8 INVOICE_ISSUED creates one in-app notification', async () => {
      const invoiceId = `inv_${testRunId}_01`;
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.INVOICE_ISSUED,
        entityType: 'invoice',
        entityId: invoiceId,
        context: {
          invoiceNumber: 'INV-2026-001',
          orderNumber: 'VN-ORD-5001',
          totalAmount: '2,999.00',
        },
        actionUrl: `/invoices/${invoiceId}`,
      });

      expect(notif.type).toBe(NotificationEventType.INVOICE_ISSUED);
      expect(notif.title).toContain('Tax Invoice Issued');
      expect(notif.body).toContain('INV-2026-001');
    });
  });

  // ===========================================================================
  // 2. IDEMPOTENCY & CONCURRENCY
  // ===========================================================================
  describe('2. Idempotency & Database Unique Constraint Safety', () => {
    it('2.1 duplicate event processing returns the exact same notification without duplication', async () => {
      const orderId = `ord_idempotent_${testRunId}`;
      const params = {
        userId: testUser1.id,
        eventType: NotificationEventType.ORDER_CONFIRMED,
        entityType: 'order',
        entityId: orderId,
        context: {
          orderNumber: 'VN-ORD-DUP-1',
          customerName: 'Test Customer',
          totalAmount: '500.00',
          orderDate: '2026-09-30',
        },
        actionUrl: `/orders/${orderId}`,
      };

      // First call
      const first = await notificationService.createInAppNotification(params);

      // Duplicate call (e.g. webhook or event replay)
      const second = await notificationService.createInAppNotification(params);

      expect(first.id).toBe(second.id);

      // Verify only ONE notification and delivery exist in PostgreSQL
      const notifs = await prisma.notification.findMany({
        where: { userId: testUser1.id, actionUrl: `/orders/${orderId}` },
      });
      expect(notifs).toHaveLength(1);

      const deliveries = await prisma.notificationDelivery.findMany({
        where: { idempotencyKey: `notif:order:${orderId}:ORDER_CONFIRMED:IN_APP` },
      });
      expect(deliveries).toHaveLength(1);
    });

    it('2.2 concurrent duplicate creation across 10 parallel callers results in exactly one notification', async () => {
      const orderId = `ord_concurrent_${testRunId}`;
      const params = {
        userId: testUser1.id,
        eventType: NotificationEventType.ORDER_CONFIRMED,
        entityType: 'order',
        entityId: orderId,
        context: {
          orderNumber: 'VN-ORD-CONCUR-1',
          customerName: 'Concurrency Test',
          totalAmount: '999.00',
          orderDate: '2026-09-30',
        },
        actionUrl: `/orders/${orderId}`,
      };

      // Launch 10 concurrent requests simultaneously using real PostgreSQL connection
      const results = await Promise.all(
        Array.from({ length: 10 }).map(() =>
          notificationService.createInAppNotification(params),
        ),
      );

      // All 10 callers must resolve to the identical notification ID
      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }

      // Verify PostgreSQL state: exactly 1 Notification and 1 NotificationDelivery
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { idempotencyKey: `notif:order:${orderId}:ORDER_CONFIRMED:IN_APP` },
      });
      expect(deliveries).toHaveLength(1);

      const notifRecords = await prisma.notification.findMany({
        where: { id: firstId },
      });
      expect(notifRecords).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 3. TRANSACTION ISOLATION & ROLLBACK
  // ===========================================================================
  describe('3. Transaction Boundary & Failure Isolation', () => {
    it('3.1 failed business transaction rolls back notification atomically (no orphan notification)', async () => {
      const orderId = `ord_rollback_${testRunId}`;

      await expect(
        prisma.$transaction(async (tx) => {
          // Inside business transaction: create notification
          await notificationService.createInAppNotification(
            {
              userId: testUser1.id,
              eventType: NotificationEventType.ORDER_CONFIRMED,
              entityType: 'order',
              entityId: orderId,
              context: {
                orderNumber: 'VN-ORD-ROLLBACK-1',
                customerName: 'Rollback Test',
                totalAmount: '1,200.00',
                orderDate: '2026-09-30',
              },
              actionUrl: `/orders/${orderId}`,
            },
            tx,
          );

          // Simulated downstream domain failure (e.g. inventory shortage or payment rollback)
          throw new Error('SIMULATED_DOMAIN_FAILURE');
        }),
      ).rejects.toThrow('SIMULATED_DOMAIN_FAILURE');

      // Assert that NO notification or delivery was persisted to PostgreSQL
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { idempotencyKey: `notif:order:${orderId}:ORDER_CONFIRMED:IN_APP` },
      });
      expect(deliveries).toHaveLength(0);

      const notifs = await prisma.notification.findMany({
        where: { actionUrl: `/orders/${orderId}` },
      });
      expect(notifs).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 4. SECURITY: CONTENT, ACTION URL, OWNERSHIP & IDOR
  // ===========================================================================
  describe('4. Security & Safety Guards', () => {
    it('4.1 notification content is plain text and free of arbitrary HTML tags', async () => {
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.ORDER_CONFIRMED,
        entityType: 'order',
        entityId: `ord_html_${testRunId}`,
        context: {
          orderNumber: '<script>alert(1)</script>ORD-999',
          customerName: '<b>Hacker</b>',
          totalAmount: '500.00',
          orderDate: '2026-09-30',
        },
        actionUrl: `/orders/ord_html_${testRunId}`,
      });

      expect(notif.body).not.toContain('<script>');
      expect(notif.body).not.toContain('<div>');
      expect(notif.title).not.toContain('<script>');
    });

    it('4.2 actionUrl cannot become an arbitrary external URL (sanitized)', async () => {
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.ORDER_CONFIRMED,
        entityType: 'order',
        entityId: `ord_url_${testRunId}`,
        context: {
          orderNumber: 'ORD-URL-1',
          customerName: 'Test',
          totalAmount: '100.00',
          orderDate: '2026-09-30',
        },
        // Malicious external action URL
        actionUrl: 'https://evil-phishing.com/steal-creds',
      });

      // Sanitizer strips absolute external URLs
      expect(notif.actionUrl).toBeNull();
    });

    it('4.3 actionUrl preserves valid application relative routes', async () => {
      const notif = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.INVOICE_ISSUED,
        entityType: 'invoice',
        entityId: `inv_rel_${testRunId}`,
        context: {
          invoiceNumber: 'INV-VALID',
          orderNumber: 'ORD-VALID',
          totalAmount: '200.00',
        },
        actionUrl: '/invoices/inv-12345',
      });

      expect(notif.actionUrl).toBe('/invoices/inv-12345');
    });

    it('4.4 enforces user ownership and IDOR isolation on read operations', async () => {
      // Create notification for User 1
      const notifUser1 = await notificationService.createInAppNotification({
        userId: testUser1.id,
        eventType: NotificationEventType.ORDER_CONFIRMED,
        entityType: 'order',
        entityId: `ord_own_${testRunId}`,
        context: {
          orderNumber: 'ORD-OWN-1',
          customerName: 'User One',
          totalAmount: '100.00',
          orderDate: '2026-09-30',
        },
        actionUrl: '/orders/ord-own-1',
      });

      // User 2 attempts to mark User 1's notification as read -> Must be Forbidden
      await expect(
        notificationService.markAsRead(notifUser1.id, testUser2.id),
      ).rejects.toThrow(ForbiddenException);

      // User 1 marks own notification as read -> Succeeds
      const updated = await notificationService.markAsRead(notifUser1.id, testUser1.id);
      expect(updated.isRead).toBe(true);
      expect(updated.readAt).toBeInstanceOf(Date);
    });
  });

  // ===========================================================================
  // 5. USER NOTIFICATION CENTER OPERATIONS
  // ===========================================================================
  describe('5. Notification Center Operations', () => {
    it('5.1 correctly calculates unread count and paginates notifications', async () => {
      const initialCount = await notificationService.getUnreadCount(testUser2.id);

      // Create 3 unread notifications for User 2
      for (let i = 1; i <= 3; i++) {
        await notificationService.createInAppNotification({
          userId: testUser2.id,
          eventType: NotificationEventType.ORDER_CONFIRMED,
          entityType: 'order',
          entityId: `ord_u2_${testRunId}_${i}`,
          context: {
            orderNumber: `ORD-U2-${i}`,
            customerName: 'User Two',
            totalAmount: '100.00',
            orderDate: '2026-09-30',
          },
          actionUrl: `/orders/ord-u2-${i}`,
        });
      }

      const countAfter = await notificationService.getUnreadCount(testUser2.id);
      expect(countAfter).toBe(initialCount + 3);

      // List notifications with pagination
      const page = await notificationService.getUserNotifications(testUser2.id, {
        limit: 2,
        offset: 0,
      });

      expect(page.data.length).toBe(2);
      expect(page.total).toBeGreaterThanOrEqual(3);
    });

    it('5.2 markAllAsRead sets all user notifications to read and reduces unread count to 0', async () => {
      const updatedCount = await notificationService.markAllAsRead(testUser2.id);
      expect(updatedCount).toBeGreaterThanOrEqual(3);

      const unreadCount = await notificationService.getUnreadCount(testUser2.id);
      expect(unreadCount).toBe(0);
    });
  });
});
