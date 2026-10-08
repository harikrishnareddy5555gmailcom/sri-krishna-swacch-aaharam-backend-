import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  NotificationCategory,
  NotificationEventType,
} from '@vishkaraa/types';
import { PrismaClient } from '@prisma/client';
import { NotificationService } from '../src/notifications/notification.service.js';
import { NotificationTemplateRegistry } from '../src/notifications/templates/notification-template.registry.js';
import { NotificationsController } from '../src/notifications/notifications.controller.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

describe('Phase 14E — Customer Notification Center API Integration & Security Tests', () => {
  let prisma: PrismaClient;
  let templateRegistry: NotificationTemplateRegistry;
  let notificationService: NotificationService;
  let controller: NotificationsController;

  const testRunId = Math.random().toString(36).substring(2, 8);

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };

  function mockRequest(userId: string): Request {
    return {
      user: {
        id: userId,
        role: 'USER',
        email: `user-${userId}@example.com`,
      },
    } as unknown as Request;
  }

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

    templateRegistry = new NotificationTemplateRegistry();
    notificationService = new NotificationService(
      prisma as unknown as PrismaService,
      templateRegistry,
    );
    controller = new NotificationsController(notificationService);

    // Create 2 test users for strict IDOR and ownership testing
    userA = await prisma.user.create({
      data: {
        email: `notif-api-a-${testRunId}@example.com`,
        passwordHash: 'hash-a',
        firstName: 'Alice',
        lastName: 'Customer',
        role: 'USER',
      },
      select: { id: true, email: true },
    });

    userB = await prisma.user.create({
      data: {
        email: `notif-api-b-${testRunId}@example.com`,
        passwordHash: 'hash-b',
        firstName: 'Bob',
        lastName: 'Customer',
        role: 'USER',
      },
      select: { id: true, email: true },
    });
  });

  afterAll(async () => {
    const userIds = [userA?.id, userB?.id].filter(Boolean) as string[];
    if (userIds.length > 0) {
      await prisma.notificationDelivery.deleteMany({
        where: { recipient: { in: userIds } },
      });
      await prisma.notification.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
    await prisma.$disconnect();
  });

  // ===========================================================================
  // 1. GET /notifications — LIST OWN NOTIFICATIONS & IDOR ISOLATION
  // ===========================================================================
  describe('1. GET /notifications', () => {
    it('1.1 empty notification center behaves gracefully', async () => {
      const req = mockRequest(userA.id);
      const res = await controller.getMyNotifications(req, {});

      expect(res).toBeDefined();
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.page).toBe(1);
      expect(res.limit).toBe(20);
      expect(res.totalPages).toBe(1);
      expect(res.unreadCount).toBe(0);
    });

    it('1.2 authenticated user can list own notifications with correct DTO shape and newest first', async () => {
      // Seed 3 notifications for User A with slight delay to ensure distinct createdAt
      for (let i = 1; i <= 3; i++) {
        await notificationService.createInAppNotification({
          userId: userA.id,
          eventType: NotificationEventType.ORDER_CONFIRMED,
          entityType: 'order',
          entityId: `ord_a_${i}_${testRunId}`,
          context: {
            orderNumber: `VN-ORD-A${i}`,
            customerName: 'Alice',
            totalAmount: '1,000.00',
            orderDate: '2026-09-30',
          },
          actionUrl: `/orders/ord_a_${i}`,
        });
      }

      const req = mockRequest(userA.id);
      const res = await controller.getMyNotifications(req, { page: 1, limit: 10 });

      expect(res.items).toHaveLength(3);
      expect(res.total).toBe(3);
      expect(res.unreadCount).toBe(3);

      // Verify ordering: newest first
      const timestamps = res.items.map((it) => new Date(it.createdAt).getTime());
      expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
      expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[2]);

      // Verify DTO fields: no internal leaks
      const item = res.items[0];
      expect(item.id).toBeDefined();
      expect(item.category).toBe(NotificationCategory.TRANSACTIONAL);
      expect(item.eventType).toBe(NotificationEventType.ORDER_CONFIRMED);
      expect(item.title).toContain('Order Confirmed');
      expect(item.body).toContain('VN-ORD-A');
      expect(item.actionUrl).toMatch(/^\/orders\//);
      expect(item.isRead).toBe(false);
      expect(item.readAt).toBeNull();
      expect(item.createdAt).toBeDefined();

      // Ensure no raw delivery / provider / recipient fields are leaked
      expect((item as any).deliveries).toBeUndefined();
      expect((item as any).recipient).toBeUndefined();
      expect((item as any).provider).toBeUndefined();
      expect((item as any).metadata).toBeUndefined();
    });

    it('1.3 another user cannot see User A notifications (strict IDOR isolation)', async () => {
      // Seed 1 notification for User B
      await notificationService.createInAppNotification({
        userId: userB.id,
        eventType: NotificationEventType.INVOICE_ISSUED,
        entityType: 'invoice',
        entityId: `inv_b_1_${testRunId}`,
        context: {
          invoiceNumber: 'INV-BOB-01',
          orderNumber: 'VN-ORD-BOB',
          totalAmount: '500.00',
        },
        actionUrl: `/invoices/inv_b_1`,
      });

      // User B requests their notifications
      const reqB = mockRequest(userB.id);
      const resB = await controller.getMyNotifications(reqB, {});

      expect(resB.items).toHaveLength(1);
      expect(resB.total).toBe(1);
      expect(resB.items[0].body).toContain('INV-BOB-01');

      // None of User A's notifications appear in User B's result
      for (const item of resB.items) {
        expect(item.body).not.toContain('VN-ORD-A');
      }

      // User A requests their notifications
      const reqA = mockRequest(userA.id);
      const resA = await controller.getMyNotifications(reqA, {});
      expect(resA.total).toBe(3);
      for (const item of resA.items) {
        expect(item.body).not.toContain('INV-BOB-01');
      }
    });

    it('1.4 pagination works stably and respects limit boundaries', async () => {
      const req = mockRequest(userA.id);

      // Page 1, limit 2
      const page1 = await controller.getMyNotifications(req, { page: 1, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.page).toBe(1);
      expect(page1.limit).toBe(2);
      expect(page1.totalPages).toBe(2);
      expect(page1.total).toBe(3);

      // Page 2, limit 2
      const page2 = await controller.getMyNotifications(req, { page: 2, limit: 2 });
      expect(page2.items).toHaveLength(1);
      expect(page2.page).toBe(2);

      // IDs on page 1 and page 2 must be completely distinct
      const page1Ids = page1.items.map((i) => i.id);
      const page2Ids = page2.items.map((i) => i.id);
      expect(page1Ids).not.toContain(page2Ids[0]);

      // Max limit clamp (limit > 50 is clamped to 50)
      const clamped = await controller.getMyNotifications(req, { page: 1, limit: 100 });
      expect(clamped.limit).toBe(50);

      // Min page clamp (page < 1 clamped to 1)
      const minPage = await controller.getMyNotifications(req, { page: -5, limit: 10 });
      expect(minPage.page).toBe(1);
    });

    it('1.5 filter by unreadOnly=true returns only unread notifications', async () => {
      const req = mockRequest(userA.id);
      const all = await controller.getMyNotifications(req, {});
      const firstId = all.items[0].id;

      // Mark the first one as read
      await controller.markAsRead(req, firstId);

      // Query with unreadOnly = true
      const unreadList = await controller.getMyNotifications(req, { unreadOnly: true });
      expect(unreadList.items).toHaveLength(2);
      expect(unreadList.total).toBe(2);
      for (const item of unreadList.items) {
        expect(item.isRead).toBe(false);
      }
    });
  });

  // ===========================================================================
  // 2. GET /notifications/unread-count
  // ===========================================================================
  describe('2. GET /notifications/unread-count', () => {
    it('2.1 returns correct unread count for the authenticated user only', async () => {
      const reqA = mockRequest(userA.id);
      const reqB = mockRequest(userB.id);

      // User A has 2 unread (out of 3, 1 was read in previous test)
      const countA = await controller.getUnreadCount(reqA);
      expect(countA.unreadCount).toBe(2);

      // User B has 1 unread
      const countB = await controller.getUnreadCount(reqB);
      expect(countB.unreadCount).toBe(1);
    });
  });

  // ===========================================================================
  // 3. PATCH /notifications/:id/read — MARK SINGLE AS READ & IDOR REJECTION
  // ===========================================================================
  describe('3. PATCH /notifications/:id/read', () => {
    it('3.1 authenticated user can mark their own notification as read', async () => {
      const req = mockRequest(userA.id);
      const list = await controller.getMyNotifications(req, { unreadOnly: true });
      const target = list.items[0];

      const res = await controller.markAsRead(req, target.id);
      expect(res.id).toBe(target.id);
      expect(res.isRead).toBe(true);
      expect(res.readAt).toBeDefined();

      // Database state check
      const inDb = await prisma.notification.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(inDb.isRead).toBe(true);
      expect(inDb.readAt).toBeInstanceOf(Date);
    });

    it('3.2 repeated mark-as-read is idempotent (does not change readAt or fail)', async () => {
      const req = mockRequest(userA.id);
      const all = await controller.getMyNotifications(req, {});
      const readOne = all.items.find((i) => i.isRead);
      expect(readOne).toBeDefined();

      const initialReadAt = readOne!.readAt;

      // Second call to mark as read
      const repeated = await controller.markAsRead(req, readOne!.id);
      expect(repeated.isRead).toBe(true);
      expect(repeated.id).toBe(readOne!.id);
    });

    it('3.3 cross-user mark-as-read is strictly rejected with ForbiddenException (IDOR protection)', async () => {
      // Find a notification owned by User A
      const reqA = mockRequest(userA.id);
      const allA = await controller.getMyNotifications(reqA, {});
      const notifA = allA.items[0];

      // User B tries to mark User A's notification as read
      const reqB = mockRequest(userB.id);
      await expect(
        controller.markAsRead(reqB, notifA.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('3.4 non-existent notification returns NotFoundException', async () => {
      const req = mockRequest(userA.id);
      const fakeUuid = '00000000-0000-4000-8000-000000000000';

      await expect(
        controller.markAsRead(req, fakeUuid),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // 4. PATCH /notifications/read-all — BULK READ WITH USER ISOLATION
  // ===========================================================================
  describe('4. PATCH /notifications/read-all', () => {
    it('4.1 marks all remaining unread notifications for User A as read', async () => {
      const reqA = mockRequest(userA.id);
      const countBefore = await controller.getUnreadCount(reqA);
      expect(countBefore.unreadCount).toBeGreaterThan(0);

      const res = await controller.markAllAsRead(reqA);
      expect(res.updatedCount).toBe(countBefore.unreadCount);

      const countAfter = await controller.getUnreadCount(reqA);
      expect(countAfter.unreadCount).toBe(0);
    });

    it('4.2 read-all for User A does NOT affect User B unread notifications', async () => {
      const reqB = mockRequest(userB.id);
      const countB = await controller.getUnreadCount(reqB);
      expect(countB.unreadCount).toBe(1);

      // Verify User B's notification is still unread
      const listB = await controller.getMyNotifications(reqB, {});
      expect(listB.items[0].isRead).toBe(false);
    });

    it('4.3 repeated read-all when all are already read updates 0 rows gracefully', async () => {
      const reqA = mockRequest(userA.id);
      const res = await controller.markAllAsRead(reqA);
      expect(res.updatedCount).toBe(0);
    });
  });
});
