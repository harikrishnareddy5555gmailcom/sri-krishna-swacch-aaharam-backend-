-- =============================================================================
-- VISHKARAA — MIGRATION 0009: REFUND LIFECYCLE & ATTEMPT TRACKING (Phase 09B)
-- =============================================================================
-- Changes:
--   1. Expand RefundStatus enum: add REQUESTED, APPROVED, REJECTED; replace PENDING
--   2. Add RefundSource enum
--   3. Add RefundAttemptStatus enum
--   4. Expand refunds table: add refundNumber, paymentAttemptId, requestedById,
--      approvedById/rejectedById, source, approvedAmount, refundedAmount, idempotencyKey, notes
--   5. Create refund_attempts table
--   6. Add FK constraints with RESTRICT on financial anchors
--   7. Add indexes for query performance
--   8. PostgreSQL CHECK constraints for financial integrity
-- =============================================================================

-- Migrate any existing PENDING refunds to PROCESSING before removing the value
UPDATE "refunds" SET "status" = 'PROCESSING' WHERE "status" = 'PENDING';

-- Expand RefundStatus enum
BEGIN;
CREATE TYPE "RefundStatus_new" AS ENUM ('REQUESTED','APPROVED','REJECTED','PROCESSING','COMPLETED','FAILED','CANCELLED');
ALTER TABLE "refunds" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "refunds" ALTER COLUMN "status" TYPE "RefundStatus_new" USING ("status"::text::"RefundStatus_new");
ALTER TYPE "RefundStatus" RENAME TO "RefundStatus_old";
ALTER TYPE "RefundStatus_new" RENAME TO "RefundStatus";
DROP TYPE "RefundStatus_old";
ALTER TABLE "refunds" ALTER COLUMN "status" SET DEFAULT 'REQUESTED';
COMMIT;

-- Add RefundSource enum
CREATE TYPE "RefundSource" AS ENUM ('MANUAL','ORDER_CANCELLATION','RETURN','DAMAGED_ITEM','ADMIN_ADJUSTMENT','SYSTEM');

-- Add RefundAttemptStatus enum
CREATE TYPE "RefundAttemptStatus" AS ENUM ('INITIATED','PENDING','PROCESSED','FAILED','RECONCILIATION_REQUIRED');

-- Remove rows with empty data (dev env — no real refund rows expected)
DELETE FROM "refunds" WHERE "orderId" = '' OR "userId" = '';

-- Expand refunds table with Phase 09B columns
ALTER TABLE "refunds"
  ADD COLUMN "refundNumber"     TEXT          NOT NULL DEFAULT '',
  ADD COLUMN "paymentAttemptId" TEXT          NOT NULL DEFAULT '',
  ADD COLUMN "requestedById"    TEXT          NOT NULL DEFAULT '',
  ADD COLUMN "source"           "RefundSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "approvedAmount"   INTEGER,
  ADD COLUMN "refundedAmount"   INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "notes"            TEXT,
  ADD COLUMN "approvedById"     TEXT,
  ADD COLUMN "approvedAt"       TIMESTAMP(3),
  ADD COLUMN "rejectedById"     TEXT,
  ADD COLUMN "rejectedAt"       TIMESTAMP(3),
  ADD COLUMN "rejectionReason"  TEXT,
  ADD COLUMN "idempotencyKey"   TEXT;

-- Make reason non-nullable
UPDATE "refunds" SET "reason" = 'Migrated from pre-09B schema' WHERE "reason" IS NULL;
ALTER TABLE "refunds" ALTER COLUMN "reason" SET NOT NULL;

-- Clean up placeholder rows so unique constraints can be added
DELETE FROM "refunds" WHERE "refundNumber" = '';

-- Unique constraints on refunds
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refundNumber_key"   UNIQUE ("refundNumber");
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_idempotencyKey_key" UNIQUE ("idempotencyKey");

-- FK: paymentAttemptId -> payment_attempts (RESTRICT)
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: requestedById -> users (RESTRICT)
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: approvedById -> users (SET NULL)
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: rejectedById -> users (SET NULL)
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_rejectedById_fkey"
  FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Update returnId FK to use SET NULL
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_returnId_fkey";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_returnId_fkey"
  FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Update userId FK to RESTRICT
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_userId_fkey";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indexes on refunds
CREATE INDEX "refunds_paymentAttemptId_idx" ON "refunds"("paymentAttemptId");
CREATE INDEX "refunds_source_idx"           ON "refunds"("source");
CREATE INDEX "refunds_createdAt_idx"        ON "refunds"("createdAt");

-- Create refund_attempts table
CREATE TABLE "refund_attempts" (
  "id"                  TEXT         NOT NULL,
  "refundId"            TEXT         NOT NULL,
  "paymentAttemptId"    TEXT         NOT NULL,
  "attemptNumber"       INTEGER      NOT NULL DEFAULT 1,
  "idempotencyKey"      TEXT         NOT NULL,
  "provider"            TEXT         NOT NULL,
  "providerRefundId"    TEXT,
  "amount"              INTEGER      NOT NULL,
  "currency"            TEXT         NOT NULL DEFAULT 'INR',
  "status"              "RefundAttemptStatus" NOT NULL DEFAULT 'INITIATED',
  "gatewayErrorCode"    TEXT,
  "gatewayErrorMessage" TEXT,
  "rawResponse"         JSONB,
  "reconciledAt"        TIMESTAMP(3),
  "reconciledBy"        TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_attempts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "refund_attempts"
  ADD CONSTRAINT "refund_attempts_idempotencyKey_key" UNIQUE ("idempotencyKey");

CREATE UNIQUE INDEX "refund_attempts_provider_refundId_key"
  ON "refund_attempts"("provider", "providerRefundId")
  WHERE "providerRefundId" IS NOT NULL;

ALTER TABLE "refund_attempts" ADD CONSTRAINT "refund_attempts_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_attempts" ADD CONSTRAINT "refund_attempts_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "refund_attempts_refundId_idx"         ON "refund_attempts"("refundId");
CREATE INDEX "refund_attempts_paymentAttemptId_idx" ON "refund_attempts"("paymentAttemptId");
CREATE INDEX "refund_attempts_status_idx"           ON "refund_attempts"("status");
CREATE INDEX "refund_attempts_providerRefundId_idx" ON "refund_attempts"("providerRefundId");
CREATE INDEX "refund_attempts_createdAt_idx"        ON "refund_attempts"("createdAt");

-- Financial CHECK constraints
ALTER TABLE "refunds"
  ADD CONSTRAINT "chk_refunds_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "chk_refunds_refundedAmount_non_negative" CHECK ("refundedAmount" >= 0);

ALTER TABLE "refund_attempts"
  ADD CONSTRAINT "chk_refund_attempts_amount_positive" CHECK ("amount" > 0);
