/**
 * Notification Subsystem Types — Phase 14
 *
 * Provider-independent domain models, channel models, enums,
 * event types, and DTOs for transactional, operational, and marketing notifications.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum NotificationChannel {
  IN_APP = 'IN_APP',
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  WHATSAPP = 'WHATSAPP',
  PUSH = 'PUSH',
}

export enum NotificationCategory {
  TRANSACTIONAL = 'TRANSACTIONAL',
  OPERATIONAL = 'OPERATIONAL',
  MARKETING = 'MARKETING',
}

export enum DeliveryStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

// ─── Notification Event Constants ────────────────────────────────────────────

export const NotificationEventType = {
  // Auth & Security
  AUTH_WELCOME: 'AUTH_WELCOME',
  AUTH_PASSWORD_RESET: 'AUTH_PASSWORD_RESET',

  // Orders
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',

  // Payments
  PAYMENT_CAPTURED: 'PAYMENT_CAPTURED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',

  // Shipping & Fulfillment
  SHIPMENT_DISPATCHED: 'SHIPMENT_DISPATCHED',
  SHIPMENT_OUT_FOR_DELIVERY: 'SHIPMENT_OUT_FOR_DELIVERY',
  SHIPMENT_DELIVERED: 'SHIPMENT_DELIVERED',
  SHIPMENT_FAILED: 'SHIPMENT_FAILED',

  // Returns & Refunds
  RETURN_APPROVED: 'RETURN_APPROVED',
  REFUND_COMPLETED: 'REFUND_COMPLETED',

  // Billing
  INVOICE_ISSUED: 'INVOICE_ISSUED',

  // Operations & Reconciliation
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
} as const;

export type NotificationEventTypeString =
  (typeof NotificationEventType)[keyof typeof NotificationEventType] | (string & {});

// ─── DTOs & Interfaces ───────────────────────────────────────────────────────

export interface NotificationDto {
  id: string;
  userId: string | null;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  readAt: Date | string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface NotificationDeliveryDto {
  id: string;
  notificationId: string;
  channel: NotificationChannel;
  recipient: string;
  status: DeliveryStatus;
  attemptCount: number;
  lastAttemptAt: Date | string | null;
  nextRetryAt: Date | string | null;
  claimedAt: Date | string | null;
  providerName: string | null;
  providerMessageId: string | null;
  failureReason: string | null;
  isRetryable: boolean;
  idempotencyKey: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface NotificationPreferenceDto {
  id: string;
  userId: string;
  category: NotificationCategory;
  channel: NotificationChannel;
  isEnabled: boolean;
  isLocked: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface CustomerNotificationItemDto {
  id: string;
  category: NotificationCategory;
  eventType: string;
  title: string;
  body: string;
  actionUrl: string | null;
  isRead: boolean;
  readAt: Date | string | null;
  createdAt: Date | string;
}

export interface CustomerNotificationListDto {
  items: CustomerNotificationItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  unreadCount: number;
}

export interface UnreadNotificationCountDto {
  unreadCount: number;
}

export interface ReadAllNotificationsDto {
  updatedCount: number;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface CreateNotificationInput {
  userId?: string | null | undefined;
  category?: NotificationCategory | undefined;
  type: string;
  title: string;
  body: string;
  actionUrl?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  expiresAt?: Date | null | undefined;
}

export interface CreateNotificationDeliveryInput {
  notificationId: string;
  channel: NotificationChannel;
  recipient: string;
  idempotencyKey: string;
  status?: DeliveryStatus | undefined;
}

export interface UpdateNotificationPreferenceInput {
  category: NotificationCategory;
  channel: NotificationChannel;
  isEnabled: boolean;
}

// ─── Provider Abstraction Types ─────────────────────────────────────────────

export interface NormalizedDeliveryResult {
  readonly providerName: string;
  readonly providerMessageId: string;
  readonly status: DeliveryStatus;
  readonly acceptedAt: Date;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface EmailInput {
  readonly to: string;
  readonly from?: string | undefined;
  readonly replyTo?: string | undefined;
  readonly subject: string;
  readonly htmlBody?: string | undefined;
  readonly textBody: string;
  readonly idempotencyKey: string;
}

export interface SmsInput {
  readonly to: string;
  readonly message: string;
  readonly dltTemplateId?: string | undefined;
  readonly idempotencyKey: string;
}

export interface IEmailProvider {
  readonly providerName: string;
  sendEmail(input: EmailInput): Promise<NormalizedDeliveryResult>;
}

export interface ISmsProvider {
  readonly providerName: string;
  sendSms(input: SmsInput): Promise<NormalizedDeliveryResult>;
}

// ─── Template Types ─────────────────────────────────────────────────────────

export interface NotificationTemplateDefinition<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly templateKey: string;
  readonly channel: NotificationChannel;
  readonly version: string;
  readonly renderSubject?: ((context: TContext) => string) | undefined;
  readonly renderText: (context: TContext) => string;
  readonly renderHtml?: ((context: TContext) => string) | undefined;
}

export interface RenderedNotification {
  readonly templateKey: string;
  readonly channel: NotificationChannel;
  readonly version: string;
  readonly subject?: string | undefined;
  readonly textBody: string;
  readonly htmlBody?: string | undefined;
}
