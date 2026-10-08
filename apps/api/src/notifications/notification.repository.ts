/**
 * Notification Repository — Phase 14B
 *
 * Encapsulates low-level database operations for Notifications, Deliveries,
 * and Preferences, with support for Prisma transaction delegation (tx).
 */

import { Injectable } from '@nestjs/common';
import {
  type Notification,
  type NotificationDelivery,
  type NotificationPreference,
  type Prisma,
  DeliveryStatus,
  NotificationCategory,
  NotificationChannel,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

export interface CreateNotificationRecordInput {
  userId?: string | null;
  category?: NotificationCategory;
  type: string;
  title: string;
  body: string;
  actionUrl?: string | null;
  metadata?: Prisma.InputJsonValue;
  expiresAt?: Date | null;
}

export interface CreateDeliveryRecordInput {
  notificationId: string;
  channel: NotificationChannel;
  recipient: string;
  status?: DeliveryStatus;
  idempotencyKey: string;
}

export interface ListUserNotificationsOptions {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
}

@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Helper to resolve the active Prisma client (either the transaction client or the global service).
   */
  private getClient(tx?: Prisma.TransactionClient): Prisma.TransactionClient | PrismaService {
    return tx ?? this.prisma;
  }

  // ─── Notification Operations ────────────────────────────────────────────────

  async createNotification(
    input: CreateNotificationRecordInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification> {
    const client = this.getClient(tx);
    return client.notification.create({
      data: {
        userId: input.userId ?? null,
        category: input.category ?? NotificationCategory.TRANSACTIONAL,
        type: input.type,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl ?? null,
        metadata: input.metadata ?? undefined,
        expiresAt: input.expiresAt ?? null,
      },
    });
  }

  async findNotificationById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification | null> {
    const client = this.getClient(tx);
    return client.notification.findUnique({
      where: { id },
    });
  }

  async listUserNotifications(
    userId: string,
    options: ListUserNotificationsOptions = {},
    tx?: Prisma.TransactionClient,
  ): Promise<{ data: Notification[]; total: number; page: number; limit: number }> {
    const client = this.getClient(tx);
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

  async countUnread(userId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = this.getClient(tx);
    return client.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });
  }

  async markAsRead(
    id: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification | null> {
    const client = this.getClient(tx);
    const existing = await client.notification.findFirst({
      where: { id, userId },
    });
    if (!existing) return null;

    return client.notification.update({
      where: { id },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  async markAllAsRead(userId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = this.getClient(tx);
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

  // ─── Delivery Operations ───────────────────────────────────────────────────

  async createDelivery(
    input: CreateDeliveryRecordInput,
    tx?: Prisma.TransactionClient,
  ): Promise<NotificationDelivery> {
    const client = this.getClient(tx);
    return client.notificationDelivery.create({
      data: {
        notificationId: input.notificationId,
        channel: input.channel,
        recipient: input.recipient,
        status: input.status ?? DeliveryStatus.PENDING,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  async findDeliveryById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<NotificationDelivery | null> {
    const client = this.getClient(tx);
    return client.notificationDelivery.findUnique({
      where: { id },
    });
  }

  async findDeliveryByIdempotencyKey(
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<NotificationDelivery | null> {
    const client = this.getClient(tx);
    return client.notificationDelivery.findUnique({
      where: { idempotencyKey },
    });
  }

  async findDeliveriesByNotificationId(
    notificationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<NotificationDelivery[]> {
    const client = this.getClient(tx);
    return client.notificationDelivery.findMany({
      where: { notificationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── Preference Operations ─────────────────────────────────────────────────

  async getUserPreferences(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<NotificationPreference[]> {
    const client = this.getClient(tx);
    return client.notificationPreference.findMany({
      where: { userId },
      orderBy: [{ category: 'asc' }, { channel: 'asc' }],
    });
  }

  async upsertPreference(
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
    isEnabled: boolean,
    isLocked = false,
    tx?: Prisma.TransactionClient,
  ): Promise<NotificationPreference> {
    const client = this.getClient(tx);
    return client.notificationPreference.upsert({
      where: {
        userId_category_channel: {
          userId,
          category,
          channel,
        },
      },
      create: {
        userId,
        category,
        channel,
        isEnabled,
        isLocked,
      },
      update: {
        // If locked, cannot be disabled
        isEnabled: isLocked ? true : isEnabled,
        isLocked,
      },
    });
  }
}
