-- =============================================================================
-- VISHKARAA — PHASE 10B MIGRATION
-- Returns / RMA / Warehouse Inspection Domain
-- =============================================================================
-- Safe additive migration:
--   1. Expand ReturnStatus enum (new values never break existing rows)
--   2. Migrate legacy UNDER_REVIEW → REQUESTED
--   3. Create ReturnItemCondition & ReturnItemDisposition enums
--   4. Add ReturnReason.WRONG_ITEM value
--   5. Add Product.isReturnable
--   6. Add Order.deliveredAt
--   7. Replace minimal returns table with full RMA aggregate
--   8. Create return_items table
-- =============================================================================

-- 1. Migrate legacy status values before removing UNDER_REVIEW
UPDATE "returns" SET "status" = 'REQUESTED' WHERE "status"::text = 'UNDER_REVIEW';

-- 2. Expand ReturnStatus enum with new Phase 10 lifecycle states
ALTER TYPE "ReturnStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
ALTER TYPE "ReturnStatus" ADD VALUE IF NOT EXISTS 'INSPECTING';
ALTER TYPE "ReturnStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED';
ALTER TYPE "ReturnStatus" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';

-- Note: UNDER_REVIEW value remains in enum (dropping enum values requires recreating
-- the type; safe to leave as dead code since no rows reference it after the UPDATE above).

-- 3. Add WRONG_ITEM to ReturnReason enum
ALTER TYPE "ReturnReason" ADD VALUE IF NOT EXISTS 'WRONG_ITEM';

-- 4. Create ReturnItemCondition enum
DO $$ BEGIN
  CREATE TYPE "ReturnItemCondition" AS ENUM (
    'UNOPENED_SEALED',
    'OPENED_UNUSED',
    'DAMAGED_IN_TRANSIT',
    'DEFECTIVE_PRODUCT',
    'CUSTOMER_DAMAGED',
    'WRONG_ITEM_SENT',
    'COUNTERFEIT_SUSPECT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. Create ReturnItemDisposition enum
DO $$ BEGIN
  CREATE TYPE "ReturnItemDisposition" AS ENUM (
    'RESTOCK',
    'REFURBISH',
    'QUARANTINE',
    'SCRAP_WRITE_OFF',
    'RETURN_TO_CUSTOMER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 6. Add Product.isReturnable (default TRUE — all existing products are returnable)
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "isReturnable" BOOLEAN NOT NULL DEFAULT true;

-- 7. Add Order.deliveredAt (null for all existing orders — legacy handling per design §4.3)
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);

-- 8. Alter returns table with all new Phase 10 columns (safe: IF NOT EXISTS, safe defaults)
ALTER TABLE "returns"
  ADD COLUMN IF NOT EXISTS "rmaNumber"           TEXT,
  ADD COLUMN IF NOT EXISTS "customerReason"      "ReturnReason",
  ADD COLUMN IF NOT EXISTS "customerNotes"       TEXT,
  ADD COLUMN IF NOT EXISTS "evidenceKeys"        TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "returnCarrier"       TEXT,
  ADD COLUMN IF NOT EXISTS "trackingNumber"      TEXT,
  ADD COLUMN IF NOT EXISTS "receivedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "requestedById"       TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedById"        TEXT,
  ADD COLUMN IF NOT EXISTS "rejectionReason"     TEXT,
  ADD COLUMN IF NOT EXISTS "inspectedById"       TEXT,
  ADD COLUMN IF NOT EXISTS "inspectedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "inspectionNotes"     TEXT,
  ADD COLUMN IF NOT EXISTS "eligibleRefundPaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "refundedPaise"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "currency"            TEXT NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS "idempotencyKey"      TEXT;

-- Backfill existing rows: generate legacy RMA numbers & map legacy columns
UPDATE "returns"
SET
  "rmaNumber"     = 'RMA-LEGACY-' || upper(substr(md5("id"::text || now()::text), 1, 8)),
  "customerReason" = "reason",
  "requestedById"  = "userId"
WHERE "rmaNumber" IS NULL;

-- Make rmaNumber NOT NULL after backfill
ALTER TABLE "returns"
  ALTER COLUMN "rmaNumber" SET NOT NULL;

-- Make customerReason NOT NULL after backfill (legacy rows now have value)
ALTER TABLE "returns"
  ALTER COLUMN "customerReason" SET NOT NULL;

-- Make requestedById NOT NULL after backfill
ALTER TABLE "returns"
  ALTER COLUMN "requestedById" SET NOT NULL;

-- Make legacy reason column nullable (superseded by customerReason)
ALTER TABLE "returns"
  ALTER COLUMN "reason" DROP NOT NULL;

-- Add unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "returns_rmaNumber_key"      ON "returns"("rmaNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "returns_idempotencyKey_key" ON "returns"("idempotencyKey");

-- Rename legacy reviewedBy column to reviewedById if it still exists under old name
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'returns' AND column_name = 'reviewedby'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'returns' AND column_name = 'reviewedById'
  ) THEN
    ALTER TABLE "returns" RENAME COLUMN "reviewedBy" TO "reviewedById";
  END IF;
END $$;

-- 9. Create return_items table
CREATE TABLE IF NOT EXISTS "return_items" (
  "id"                TEXT        NOT NULL PRIMARY KEY,
  "returnId"          TEXT        NOT NULL REFERENCES "returns"("id") ON DELETE CASCADE,
  "orderItemId"       TEXT        NOT NULL REFERENCES "order_items"("id") ON DELETE RESTRICT,
  "requestedQuantity" INTEGER     NOT NULL CHECK ("requestedQuantity" > 0),
  "receivedQuantity"  INTEGER     NOT NULL DEFAULT 0 CHECK ("receivedQuantity" >= 0),
  "acceptedQuantity"  INTEGER     NOT NULL DEFAULT 0 CHECK ("acceptedQuantity" >= 0),
  "rejectedQuantity"  INTEGER     NOT NULL DEFAULT 0 CHECK ("rejectedQuantity" >= 0),
  "reason"            "ReturnReason" NOT NULL,
  "customerNotes"     TEXT,
  "condition"         "ReturnItemCondition",
  "disposition"       "ReturnItemDisposition",
  "inspectorNotes"    TEXT,
  "itemRefundPaise"   INTEGER     NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- return_items indexes
CREATE UNIQUE INDEX IF NOT EXISTS "return_items_returnId_orderItemId_key"
  ON "return_items"("returnId", "orderItemId");
CREATE INDEX IF NOT EXISTS "return_items_returnId_idx"
  ON "return_items"("returnId");
CREATE INDEX IF NOT EXISTS "return_items_orderItemId_idx"
  ON "return_items"("orderItemId");
