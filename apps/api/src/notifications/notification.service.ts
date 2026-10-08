import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import {
  Prisma,
  type Notification,
  DeliveryStatus,
} from '@prisma/client';
import {
  NotificationCategory,
  NotificationChannel,
  type NotificationEventTypeString,
  type CustomerNotificationItemDto,
  type CustomerNotificationListDto,
} from '@vishkaraa/types';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationTemplateRegistry } from './templates/notification-template.registry.js';
import { sanitizeActionUrl } from './templates/notification-template.security.js';
import {
  getCategoryForEventType,
  isChannelMandatory,
} from './notification-domain.constants.js';

function stripHtml(input: string): string {
  if (!input) return '';
  return input.replace(/<[^>]*>?/gm, '').trim();
}

export function mapToCustomerNotificationDto(notification: Notification): CustomerNotificationItemDto {
  return {
    id: notification.id,
    category: notification.category as NotificationCategory,
    eventType: notification.type,
    title: notification.title,
    body: notification.body,
    actionUrl: notification.actionUrl,
    isRead: notification.isRead,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

export interface CreateInAppNotificationParams {
  /** Owning user ID, or null for system operational notifications */
  userId: string | null;
  /** Notification event type constant */
  eventType: NotificationEventTypeString;
  /** Target domain entity type (e.g. 'order', 'payment', 'shipment', 'invoice') */
  entityType: string;
  /** Authoritative target entity ID */
  entityId: string;
  /** Template rendering variables */
  context: Record<string, unknown>;
  /** Optional category override; defaults to mapped category */
  category?: NotificationCategory;
  /** Safe relative application route (e.g. '/orders/123') */
  actionUrl?: string | null;
  /** Additional structured domain metadata */
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templateRegistry: NotificationTemplateRegistry,
  ) {}

  /**
   * Generates a deterministic, collision-resistant idempotency key for IN_APP notifications.
   * Format: notif:{entityType}:{entityId}:{eventType}:IN_APP
   */
  public generateInAppIdempotencyKey(
    entityType: string,
    entityId: string,
    eventType: string,
  ): string {
    const cleanEntity = entityType.trim().toLowerCase();
    const cleanId = entityId.trim();
    const cleanEvent = eventType.trim().toUpperCase();
    return `notif:${cleanEntity}:${cleanId}:${cleanEvent}:IN_APP`;
  }

  /**
   * Creates an IN_APP notification and its corresponding IN_APP delivery record.
   *
   * Transaction Safety:
   * - If an active `tx` is provided, all operations occur atomically inside `tx`.
   * - If `tx` is omitted, operations run in a dedicated atomic transaction.
   *
   * Idempotency & Concurrency:
   * - Uses database-level unique constraint on `notification_deliveries.idempotencyKey`.
   * - Duplicate requests safely return the existing Notification.
   * - In-app notifications are immediately marked SENT upon transaction commit.
   */
  public async createInAppNotification(
    params: CreateInAppNotificationParams,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification> {
    const { userId, eventType, entityType, entityId, context, actionUrl, metadata } = params;

    if (!eventType) {
      throw new BadRequestException('Notification eventType is required');
    }
    if (!entityType || !entityId) {
      throw new BadRequestException('Notification entityType and entityId are required');
    }

    // 1. Sanitize actionUrl — strictly relative path only
    const cleanActionUrl = sanitizeActionUrl(actionUrl);

    // 2. Generate authoritative idempotency key
    const idempotencyKey = this.generateInAppIdempotencyKey(entityType, entityId, eventType);

    // 3. User notification preference check (if user-targeted and non-mandatory)
    if (userId) {
      const isMandatory = isChannelMandatory(eventType, NotificationChannel.IN_APP);
      if (!isMandatory) {
        const category = getCategoryForEventType(eventType);
        const client = tx ?? this.prisma;
        const preference = await client.notificationPreference.findUnique({
          where: {
            userId_category_channel: {
              userId,
              category,
              channel: NotificationChannel.IN_APP,
            },
          },
        });
        if (preference && !preference.isEnabled) {
          this.logger.log(
            `[NOTIF_PREF] Skipping optional in-app notification ${eventType} for user ${userId} per preferences`,
          );
          // Return existing or null if skipped
          const existing = await client.notificationDelivery.findUnique({
            where: { idempotencyKey },
            include: { notification: true },
          });
          if (existing) return existing.notification;
          throw new BadRequestException('Notification disabled by user preference');
        }
      }
    }

    // 4. Render IN_APP template (plain text only)
    const rendered = this.templateRegistry.render(
      eventType,
      NotificationChannel.IN_APP,
      context,
    );

    const category = getCategoryForEventType(eventType);
    const title = stripHtml(rendered.subject || eventType);
    const body = stripHtml(rendered.textBody);

    // 5. Atomic persistence
    const executeInTransaction = async (client: Prisma.TransactionClient): Promise<Notification> => {
      // Application check: find existing delivery with this idempotency key
      const existingDelivery = await client.notificationDelivery.findUnique({
        where: { idempotencyKey },
        include: { notification: true },
      });

      if (existingDelivery) {
        return existingDelivery.notification;
      }

      // Create Notification record
      const notification = await client.notification.create({
        data: {
          userId: userId ?? null,
          category: params.category || category,
          type: eventType,
          title,
          body,
          actionUrl: cleanActionUrl,
          metadata: metadata ? (metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          isRead: false,
        },
      });

      // Create IN_APP NotificationDelivery record
      await client.notificationDelivery.create({
        data: {
          notificationId: notification.id,
          channel: NotificationChannel.IN_APP,
          recipient: userId ?? 'SYSTEM',
          status: DeliveryStatus.SENT,
          attemptCount: 1,
          lastAttemptAt: new Date(),
          idempotencyKey,
        },
      });

      return notification;
    };

    if (tx) {
      return await executeInTransaction(tx);
    }

    // When running standalone, handle concurrent unique-constraint races safely
    try {
      return await this.prisma.$transaction(async (innerTx) => {
        return await executeInTransaction(innerTx);
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.notificationDelivery.findUnique({
          where: { idempotencyKey },
          include: { notification: true },
        });
        if (existing) {
          return existing.notification;
        }
      }
      throw err;
    }
  }

  /**
   * Retrieves paginated notifications for a customer notification center.
   */
  public async getUserNotifications(
    userId: string,
    options: { page?: number; limit?: number; unreadOnly?: boolean } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<{ data: Notification[]; total: number; page: number; limit: number }> {
    const client = tx ?? this.prisma;
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(options.unreadOnly ? { isRead: false } : {}),
    };

    const [data, total] = await Promise.all([
      client.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      client.notification.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Retrieves paginated customer notifications formatted for the customer notification center.
   */
  public async getCustomerNotificationList(
    userId: string,
    options: { page?: number; limit?: number; unreadOnly?: boolean } = {},
  ): Promise<CustomerNotificationListDto> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(options.unreadOnly ? { isRead: false } : {}),
    };

    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items: data.map(mapToCustomerNotificationDto),
      total,
      page,
      limit,
      totalPages,
      unreadCount,
    };
  }

  /**
   * Retrieves the unread notification count for a customer.
   */
  public async getUnreadCount(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    return client.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });
  }

  /**
   * Marks a single notification as read, validating customer ownership.
   * Strictly idempotent: if already read, returns the existing record without write update.
   */
  public async markAsRead(
    notificationId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification> {
    const client = tx ?? this.prisma;
    const existing = await client.notification.findUnique({
      where: { id: notificationId },
    });
    if (!existing) {
      throw new NotFoundException(`Notification '${notificationId}' not found`);
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException(`Cannot access notification belonging to another user`);
    }

    if (existing.isRead) {
      return existing; // idempotent no-op
    }

    return client.notification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  /**
   * Marks all notifications as read for a customer.
   */
  public async markAllAsRead(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    const result = await client.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
    return result.count;
  }
}
