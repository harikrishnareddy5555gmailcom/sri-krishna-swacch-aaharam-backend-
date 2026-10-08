import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FeatureKey,
  FeatureStatus,
  FeatureCategory,
  Permissions,
  UserRole,
  NotificationChannel,
  NotificationChannel as TypeNotificationChannel,
  NotificationCategory,
  NotificationCategory as TypeNotificationCategory,
  DeliveryStatus,
  DeliveryStatus as TypeDeliveryStatus,
  NotificationEventType,
} from '@vishkaraa/types';
import {
  FEATURE_REGISTRY,
  PERMISSION_REGISTRY,
  DEFAULT_ROLE_PERMISSIONS,
  evaluateEffectivePermissions,
} from '@vishkaraa/shared';
import {
  PrismaClient,
  NotificationChannel as PrismaNotificationChannel,
  NotificationCategory as PrismaNotificationCategory,
  DeliveryStatus as PrismaDeliveryStatus,
  Prisma,
} from '@prisma/client';
import {
  EVENT_CHANNEL_PREFERENCE_MATRIX,
  getCategoryForEventType,
} from '../src/notifications/notification-domain.constants.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { PrismaService } from '../src/database/prisma.service.js';

describe('Phase 14B — Notifications Domain Foundation', () => {
  let prisma: PrismaClient;
  let repository: NotificationRepository;
  const testRunId = Math.random().toString(36).substring(2, 8);

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
    repository = new NotificationRepository(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    // Clean up test users created in this run
    await prisma.user.deleteMany({
      where: { email: { contains: `notif-test-${testRunId}` } },
    });
    await prisma.$disconnect();
  });

  // ===========================================================================
  // 1. DOMAIN ENUMS & CONSTANTS VALIDITY
  // ===========================================================================
  describe('1. Domain Enums & Event Constants Validity', () => {
    it('1.1 validates NotificationChannel enum parity between types and Prisma', () => {
      const expectedChannels = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'];
      for (const channel of expectedChannels) {
        expect(TypeNotificationChannel).toHaveProperty(channel);
        expect(PrismaNotificationChannel).toHaveProperty(channel);
        expect(TypeNotificationChannel[channel as keyof typeof TypeNotificationChannel]).toBe(channel);
        expect(PrismaNotificationChannel[channel as keyof typeof PrismaNotificationChannel]).toBe(channel);
      }
    });

    it('1.2 validates NotificationCategory enum parity between types and Prisma', () => {
      const expectedCategories = ['TRANSACTIONAL', 'OPERATIONAL', 'MARKETING'];
      for (const category of expectedCategories) {
        expect(TypeNotificationCategory).toHaveProperty(category);
        expect(PrismaNotificationCategory).toHaveProperty(category);
        expect(TypeNotificationCategory[category as keyof typeof TypeNotificationCategory]).toBe(category);
        expect(PrismaNotificationCategory[category as keyof typeof PrismaNotificationCategory]).toBe(category);
      }
    });

    it('1.3 validates DeliveryStatus enum values and correct state semantics (SENT instead of false DELIVERED claim)', () => {
      const expectedStatuses = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED'];
      for (const status of expectedStatuses) {
        expect(TypeDeliveryStatus).toHaveProperty(status);
        expect(PrismaDeliveryStatus).toHaveProperty(status);
        expect(TypeDeliveryStatus[status as keyof typeof TypeDeliveryStatus]).toBe(status);
        expect(PrismaDeliveryStatus[status as keyof typeof PrismaDeliveryStatus]).toBe(status);
      }
      // Confirms DELIVERED is NOT a DeliveryStatus (we do not claim delivery without carrier proof)
      expect(TypeDeliveryStatus).not.toHaveProperty('DELIVERED');
      expect(TypeDeliveryStatus).not.toHaveProperty('DISPATCHED');
    });

    it('1.4 validates all 14 required Phase 14 NotificationEventType constants', () => {
      const expectedEvents = [
        'AUTH_WELCOME',
        'AUTH_PASSWORD_RESET',
        'ORDER_CONFIRMED',
        'ORDER_CANCELLED',
        'PAYMENT_CAPTURED',
        'PAYMENT_FAILED',
        'SHIPMENT_DISPATCHED',
        'SHIPMENT_OUT_FOR_DELIVERY',
        'SHIPMENT_DELIVERED',
        'SHIPMENT_FAILED',
        'RETURN_APPROVED',
        'REFUND_COMPLETED',
        'INVOICE_ISSUED',
        'RECONCILIATION_REQUIRED',
      ] as const;

      for (const evt of expectedEvents) {
        expect(NotificationEventType).toHaveProperty(evt);
        expect(NotificationEventType[evt]).toBe(evt);
      }
    });

    it('1.5 validates event preference matrix and category resolution', () => {
      expect(getCategoryForEventType(NotificationEventType.ORDER_CONFIRMED)).toBe(
        TypeNotificationCategory.TRANSACTIONAL,
      );
      expect(getCategoryForEventType(NotificationEventType.RECONCILIATION_REQUIRED)).toBe(
        TypeNotificationCategory.OPERATIONAL,
      );

      // Verify ORDER_CONFIRMED channel rules: IN_APP mandatory, EMAIL mandatory, SMS optional
      const orderConfirmedRules = EVENT_CHANNEL_PREFERENCE_MATRIX[NotificationEventType.ORDER_CONFIRMED];
      expect(orderConfirmedRules[TypeNotificationChannel.IN_APP]).toEqual({
        isSupported: true,
        isMandatory: true,
        defaultEnabled: true,
      });
      expect(orderConfirmedRules[TypeNotificationChannel.EMAIL]).toEqual({
        isSupported: true,
        isMandatory: true,
        defaultEnabled: true,
      });
      expect(orderConfirmedRules[TypeNotificationChannel.SMS]).toEqual({
        isSupported: true,
        isMandatory: false,
        defaultEnabled: true,
      });
    });
  });

  // ===========================================================================
  // 2. FEATURE REGISTRY & PERMISSION ENGINE COMPATIBILITY
  // ===========================================================================
  describe('2. Feature Registry & Permission Engine Compatibility', () => {
    it('2.1 verifies FeatureKey.NOTIFICATIONS registration in FEATURE_REGISTRY', () => {
      const feat = FEATURE_REGISTRY[FeatureKey.NOTIFICATIONS];
      expect(feat).toBeDefined();
      expect(feat.key).toBe(FeatureKey.NOTIFICATIONS);
      expect(feat.status).toBe(FeatureStatus.ACTIVE);
      expect(feat.defaultEnabled).toBe(true);
      expect(feat.category).toBe(FeatureCategory.SYSTEM);
      expect(feat.permissions).toContain(Permissions.NOTIFICATIONS_VIEW);
      expect(feat.permissions).toContain(Permissions.NOTIFICATIONS_MANAGE);
      expect(feat.permissions).toContain(Permissions.NOTIFICATIONS_RETRY);
      expect(feat.permissions).toContain(Permissions.NOTIFICATIONS_TEMPLATES);
    });

    it('2.2 verifies notification permissions in PERMISSION_REGISTRY', () => {
      expect(PERMISSION_REGISTRY[Permissions.NOTIFICATIONS_VIEW]).toMatchObject({
        key: Permissions.NOTIFICATIONS_VIEW,
        resource: 'NOTIFICATIONS',
        action: 'VIEW',
        featureKey: FeatureKey.NOTIFICATIONS,
        isAssignableToAdmin: true,
      });
      expect(PERMISSION_REGISTRY[Permissions.NOTIFICATIONS_MANAGE]).toMatchObject({
        key: Permissions.NOTIFICATIONS_MANAGE,
        resource: 'NOTIFICATIONS',
        action: 'MANAGE',
        featureKey: FeatureKey.NOTIFICATIONS,
        isAssignableToAdmin: true,
      });
      expect(PERMISSION_REGISTRY[Permissions.NOTIFICATIONS_RETRY]).toMatchObject({
        key: Permissions.NOTIFICATIONS_RETRY,
        resource: 'NOTIFICATIONS',
        action: 'RETRY',
        featureKey: FeatureKey.NOTIFICATIONS,
        isAssignableToAdmin: true,
      });
      expect(PERMISSION_REGISTRY[Permissions.NOTIFICATIONS_TEMPLATES]).toMatchObject({
        key: Permissions.NOTIFICATIONS_TEMPLATES,
        resource: 'NOTIFICATIONS',
        action: 'TEMPLATES',
        featureKey: FeatureKey.NOTIFICATIONS,
        isAssignableToAdmin: true,
      });
    });

    it('2.3 verifies role permissions for USER, ADMIN, and SUPER_ADMIN', () => {
      expect(DEFAULT_ROLE_PERMISSIONS[UserRole.USER]).toContain(Permissions.NOTIFICATIONS_VIEW);
      expect(DEFAULT_ROLE_PERMISSIONS[UserRole.ADMIN]).toContain(Permissions.NOTIFICATIONS_VIEW);

      // SuperAdmin inherits all permissions via platform wildcard
      const superAdminPerms = evaluateEffectivePermissions({
        userId: 'super-admin-uuid',
        role: UserRole.SUPER_ADMIN,
      });
      expect(superAdminPerms.isSuperAdmin).toBe(true);
      expect(superAdminPerms.allowed).toContain(Permissions.NOTIFICATIONS_VIEW);
      expect(superAdminPerms.allowed).toContain(Permissions.NOTIFICATIONS_MANAGE);
      expect(superAdminPerms.allowed).toContain(Permissions.NOTIFICATIONS_RETRY);
      expect(superAdminPerms.allowed).toContain(Permissions.NOTIFICATIONS_TEMPLATES);
    });
  });

  // ===========================================================================
  // 3. PHYSICAL DATABASE & MIGRATION INTEGRITY (REAL POSTGRESQL)
  // ===========================================================================
  describe('3. Physical Database & Schema Integrity', () => {
    let testUser: { id: string; email: string };

    beforeAll(async () => {
      testUser = await prisma.user.create({
        data: {
          email: `notif-test-${testRunId}@vishkaraa.local`,
          passwordHash: '$2b$12$dummyhashfornotificationstesting1234567890123456789012',
          firstName: 'Ananya',
          lastName: 'Sharma',
          role: 'USER',
        },
      });
    });

    it('3.1 creates Notification and NotificationDelivery with claimedAt and idempotency key', async () => {
      const idempotencyKey = `notif:test:${testRunId}:001:EMAIL`;

      const notification = await prisma.notification.create({
        data: {
          userId: testUser.id,
          category: PrismaNotificationCategory.TRANSACTIONAL,
          type: NotificationEventType.ORDER_CONFIRMED,
          title: 'Order Confirmed',
          body: 'Your order VN-TEST-001 has been confirmed successfully.',
          actionUrl: '/orders/VN-TEST-001',
          metadata: { orderId: 'ord-test-001', totalAmount: 149900 },
          deliveries: {
            create: {
              channel: PrismaNotificationChannel.EMAIL,
              recipient: testUser.email,
              status: PrismaDeliveryStatus.PENDING,
              idempotencyKey,
            },
          },
        },
        include: {
          deliveries: true,
        },
      });

      expect(notification.id).toBeDefined();
      expect(notification.userId).toBe(testUser.id);
      expect(notification.isRead).toBe(false);
      expect(notification.readAt).toBeNull();
      expect(notification.deliveries).toHaveLength(1);

      const delivery = notification.deliveries[0]!;
      expect(delivery.channel).toBe(PrismaNotificationChannel.EMAIL);
      expect(delivery.status).toBe(PrismaDeliveryStatus.PENDING);
      expect(delivery.recipient).toBe(testUser.email);
      expect(delivery.idempotencyKey).toBe(idempotencyKey);
      expect(delivery.attemptCount).toBe(0);
      expect(delivery.claimedAt).toBeNull();

      // Test worker timestamp claim update
      const now = new Date();
      const updatedDelivery = await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: PrismaDeliveryStatus.PROCESSING,
          claimedAt: now,
          attemptCount: { increment: 1 },
        },
      });
      expect(updatedDelivery.status).toBe(PrismaDeliveryStatus.PROCESSING);
      expect(updatedDelivery.claimedAt).toEqual(now);
      expect(updatedDelivery.attemptCount).toBe(1);
    });

    it('3.2 enforces unique constraint on NotificationDelivery.idempotencyKey', async () => {
      const idempotencyKey = `notif:test:${testRunId}:dup:SMS`;

      const notif = await prisma.notification.create({
        data: {
          userId: testUser.id,
          type: NotificationEventType.ORDER_CONFIRMED,
          title: 'Test',
          body: 'Test duplicate suppression',
        },
      });

      // First delivery creation succeeds
      await prisma.notificationDelivery.create({
        data: {
          notificationId: notif.id,
          channel: PrismaNotificationChannel.SMS,
          recipient: '+919876543210',
          idempotencyKey,
        },
      });

      // Second delivery with identical idempotencyKey MUST fail with P2002
      await expect(
        prisma.notificationDelivery.create({
          data: {
            notificationId: notif.id,
            channel: PrismaNotificationChannel.SMS,
            recipient: '+919876543210',
            idempotencyKey,
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });

    it('3.3 enforces non-negative attemptCount check constraint on notification_deliveries', async () => {
      const notif = await prisma.notification.create({
        data: {
          userId: testUser.id,
          type: NotificationEventType.ORDER_CONFIRMED,
          title: 'Check Constraint Test',
          body: 'Testing attemptCount >= 0',
        },
      });

      // Attempting negative attemptCount via raw query must violate chk_notification_delivery_attempt_count_non_negative
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "notification_deliveries" ("id", "notificationId", "channel", "recipient", "status", "attemptCount", "isRetryable", "idempotencyKey", "createdAt", "updatedAt")
          VALUES (gen_random_uuid(), '${notif.id}', 'EMAIL', 'test@test.com', 'PENDING', -1, false, 'notif:test:neg:${Math.random()}', NOW(), NOW());
        `),
      ).rejects.toThrow();
    });

    it('3.4 supports nullable userId for system-wide operational notifications', async () => {
      const operationalNotification = await prisma.notification.create({
        data: {
          userId: null, // Nullable by design for system operational alerts
          category: PrismaNotificationCategory.OPERATIONAL,
          type: NotificationEventType.RECONCILIATION_REQUIRED,
          title: 'Courier Discrepancy Flagged',
          body: 'Shipment SHP-001 flagged: carrier reported DELIVERED while local was PACKED',
          metadata: { shipmentId: 'shp-001', discrepancy: 'STATUS_MISMATCH' },
        },
      });

      expect(operationalNotification.id).toBeDefined();
      expect(operationalNotification.userId).toBeNull();
      expect(operationalNotification.category).toBe(PrismaNotificationCategory.OPERATIONAL);
      expect(operationalNotification.type).toBe(NotificationEventType.RECONCILIATION_REQUIRED);
    });

    it('3.5 enforces unique constraint on NotificationPreference (userId, category, channel)', async () => {
      // Create preference
      const pref1 = await prisma.notificationPreference.create({
        data: {
          userId: testUser.id,
          category: PrismaNotificationCategory.MARKETING,
          channel: PrismaNotificationChannel.EMAIL,
          isEnabled: false,
          isLocked: false,
        },
      });
      expect(pref1.id).toBeDefined();

      // Duplicate (userId, category, channel) MUST fail with P2002
      await expect(
        prisma.notificationPreference.create({
          data: {
            userId: testUser.id,
            category: PrismaNotificationCategory.MARKETING,
            channel: PrismaNotificationChannel.EMAIL,
            isEnabled: true,
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });

    it('3.6 verifies Cascade behavior: deleting User cascades to Notifications and Preferences', async () => {
      const ephemeralUser = await prisma.user.create({
        data: {
          email: `notif-cascade-${testRunId}@vishkaraa.local`,
          passwordHash: '$2b$12$dummyhashfornotificationstesting1234567890123456789012',
          firstName: 'Ephemeral',
          lastName: 'User',
          role: 'USER',
        },
      });

      const notif = await prisma.notification.create({
        data: {
          userId: ephemeralUser.id,
          type: NotificationEventType.AUTH_WELCOME,
          title: 'Welcome',
          body: 'Welcome to Vishkaraa Naturals',
          deliveries: {
            create: {
              channel: PrismaNotificationChannel.EMAIL,
              recipient: ephemeralUser.email,
              idempotencyKey: `notif:cascade:del:${ephemeralUser.id}`,
            },
          },
        },
      });

      await prisma.notificationPreference.create({
        data: {
          userId: ephemeralUser.id,
          category: PrismaNotificationCategory.TRANSACTIONAL,
          channel: PrismaNotificationChannel.EMAIL,
          isEnabled: true,
          isLocked: true,
        },
      });

      // Deleting the ephemeral user MUST cascade to notifications, deliveries, and preferences
      await prisma.user.delete({
        where: { id: ephemeralUser.id },
      });

      const remainingNotif = await prisma.notification.findUnique({ where: { id: notif.id } });
      const remainingDeliv = await prisma.notificationDelivery.findUnique({
        where: { idempotencyKey: `notif:cascade:del:${ephemeralUser.id}` },
      });
      const remainingPref = await prisma.notificationPreference.findFirst({
        where: { userId: ephemeralUser.id },
      });

      expect(remainingNotif).toBeNull();
      expect(remainingDeliv).toBeNull();
      expect(remainingPref).toBeNull();
    });
  });

  // ===========================================================================
  // 4. NOTIFICATION REPOSITORY INTEGRATION
  // ===========================================================================
  describe('4. NotificationRepository Operations', () => {
    let repoUser: { id: string; email: string };

    beforeAll(async () => {
      repoUser = await prisma.user.create({
        data: {
          email: `notif-repo-${testRunId}@vishkaraa.local`,
          passwordHash: '$2b$12$dummyhashfornotificationstesting1234567890123456789012',
          firstName: 'Repo',
          lastName: 'Tester',
          role: 'USER',
        },
      });
    });

    it('4.1 creates notification and deliveries through repository', async () => {
      const notif = await repository.createNotification({
        userId: repoUser.id,
        category: NotificationCategory.TRANSACTIONAL,
        type: NotificationEventType.ORDER_CONFIRMED,
        title: 'Order Confirmed',
        body: 'Thank you for your order.',
        actionUrl: '/orders/123',
      });

      expect(notif.id).toBeDefined();
      expect(notif.isRead).toBe(false);

      const deliv = await repository.createDelivery({
        notificationId: notif.id,
        channel: NotificationChannel.EMAIL,
        recipient: repoUser.email,
        idempotencyKey: `notif:repo:del:${notif.id}`,
      });

      expect(deliv.id).toBeDefined();
      expect(deliv.status).toBe(DeliveryStatus.PENDING);

      const foundDeliv = await repository.findDeliveryByIdempotencyKey(`notif:repo:del:${notif.id}`);
      expect(foundDeliv?.id).toBe(deliv.id);
    });

    it('4.2 lists user notifications, unread count, and marks as read', async () => {
      // Initially 1 unread notification from previous test
      let unreadCount = await repository.countUnread(repoUser.id);
      expect(unreadCount).toBeGreaterThanOrEqual(1);

      const list = await repository.listUserNotifications(repoUser.id, { page: 1, limit: 10 });
      expect(list.data.length).toBeGreaterThanOrEqual(1);
      expect(list.total).toBeGreaterThanOrEqual(1);

      const firstNotif = list.data[0]!;
      expect(firstNotif.isRead).toBe(false);

      // Mark single notification read
      const updated = await repository.markAsRead(firstNotif.id, repoUser.id);
      expect(updated?.isRead).toBe(true);
      expect(updated?.readAt).toBeDefined();

      // Create two more unread
      await repository.createNotification({
        userId: repoUser.id,
        type: NotificationEventType.SHIPMENT_DISPATCHED,
        title: 'Shipped 1',
        body: 'Package 1 dispatched',
      });
      await repository.createNotification({
        userId: repoUser.id,
        type: NotificationEventType.SHIPMENT_DELIVERED,
        title: 'Delivered 2',
        body: 'Package 2 delivered',
      });

      unreadCount = await repository.countUnread(repoUser.id);
      expect(unreadCount).toBe(2);

      // Mark all read
      const markedCount = await repository.markAllAsRead(repoUser.id);
      expect(markedCount).toBe(2);

      unreadCount = await repository.countUnread(repoUser.id);
      expect(unreadCount).toBe(0);
    });

    it('4.3 manages user preferences through repository upsert', async () => {
      // Upsert preference: marketing email disabled
      const pref1 = await repository.upsertPreference(
        repoUser.id,
        NotificationCategory.MARKETING,
        NotificationChannel.EMAIL,
        false,
        false,
      );
      expect(pref1.isEnabled).toBe(false);
      expect(pref1.isLocked).toBe(false);

      // Upsert preference: transactional email locked to enabled
      const pref2 = await repository.upsertPreference(
        repoUser.id,
        NotificationCategory.TRANSACTIONAL,
        NotificationChannel.EMAIL,
        true,
        true, // isLocked
      );
      expect(pref2.isEnabled).toBe(true);
      expect(pref2.isLocked).toBe(true);

      const allPrefs = await repository.getUserPreferences(repoUser.id);
      expect(allPrefs.length).toBeGreaterThanOrEqual(2);
    });
  });
});
