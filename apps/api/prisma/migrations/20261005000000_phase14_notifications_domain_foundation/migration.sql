-- Phase 14: Notifications Domain Foundation Migration
-- Creates notifications, notification_deliveries, and notification_preferences tables with strict CASCADE foreign keys and optimal indexes.

-- 1. Create Enums
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH');
CREATE TYPE "NotificationCategory" AS ENUM ('TRANSACTIONAL', 'OPERATIONAL', 'MARKETING');
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');

-- 2. Create Table: notifications
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "category" "NotificationCategory" NOT NULL DEFAULT 'TRANSACTIONAL',
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionUrl" TEXT,
    "metadata" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- 3. Create Table: notification_deliveries
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "providerName" TEXT,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "isRetryable" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_notification_delivery_attempt_count_non_negative" CHECK ("attemptCount" >= 0)
);

-- 4. Create Table: notification_preferences
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- 5. Create Indexes and Constraints
-- notifications
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");
CREATE INDEX "notifications_category_idx" ON "notifications"("category");
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- notification_deliveries
CREATE UNIQUE INDEX "notification_deliveries_idempotencyKey_key" ON "notification_deliveries"("idempotencyKey");
CREATE INDEX "notification_deliveries_status_nextRetryAt_idx" ON "notification_deliveries"("status", "nextRetryAt");
CREATE INDEX "notification_deliveries_status_claimedAt_idx" ON "notification_deliveries"("status", "claimedAt");
CREATE INDEX "notification_deliveries_notificationId_idx" ON "notification_deliveries"("notificationId");
CREATE INDEX "notification_deliveries_channel_idx" ON "notification_deliveries"("channel");

-- notification_preferences
CREATE UNIQUE INDEX "notification_preferences_userId_category_channel_key" ON "notification_preferences"("userId", "category", "channel");
CREATE INDEX "notification_preferences_userId_idx" ON "notification_preferences"("userId");

-- 6. Add Foreign Key Constraints
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
