-- =============================================================================
-- VISHKARAA — MIGRATION 0008: ORDER FINALIZATION (Phase 08A)
-- =============================================================================
-- Changes:
--   1. OrderStatus enum: remove PENDING/RETURN_REQUESTED/RETURNED/REFUND_PENDING/
--      PARTIALLY_REFUNDED/REFUNDED (Phase 09+ deferred). Add CANCELLED.
--   2. checkout_item_snapshots: add variantName (NOT NULL)
--   3. checkout_sessions: add 8 shipping address fields (all nullable)
--   4. order_items: replace totalPrice→lineTotal, drop updatedAt (immutable),
--      add variantId, variantName, primaryImageUrl, currency; make productId nullable
--   5. orders: add orderNumber (UNIQUE), paymentAttemptId (UNIQUE),
--      checkoutSessionId; add shipping snapshot fields; add confirmedAt/cancelledAt;
--      remove refundedAmount; change status default to CONFIRMED
--   6. New indexes and FK constraints (RESTRICT/CASCADE/SET NULL per design)
--   7. PostgreSQL CHECK constraints for financial integrity
-- =============================================================================

-- AlterEnum: Rebuild OrderStatus with Phase 08 minimal set
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('CONFIRMED', 'CANCELLED', 'PROCESSING', 'SHIPPED', 'DELIVERED');
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';
COMMIT;

-- DropForeignKey: Remove old unconstrained FKs (will re-add with correct policies)
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_orderId_fkey";
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_orderId_fkey";

-- AlterTable: checkout_item_snapshots — add variantName snapshot
ALTER TABLE "checkout_item_snapshots" ADD COLUMN "variantName" TEXT NOT NULL DEFAULT '';

-- AlterTable: checkout_sessions — add shipping address fields (all nullable)
ALTER TABLE "checkout_sessions"
  ADD COLUMN "shippingName"       TEXT,
  ADD COLUMN "shippingPhone"      TEXT,
  ADD COLUMN "shippingLine1"      TEXT,
  ADD COLUMN "shippingLine2"      TEXT,
  ADD COLUMN "shippingCity"       TEXT,
  ADD COLUMN "shippingState"      TEXT,
  ADD COLUMN "shippingPostalCode" TEXT,
  ADD COLUMN "shippingCountry"    TEXT;

-- AlterTable: order_items — full Phase 08A immutable snapshot redesign
ALTER TABLE "order_items"
  DROP COLUMN "totalPrice",
  DROP COLUMN "updatedAt",
  ADD COLUMN  "variantId"       TEXT,
  ADD COLUMN  "variantName"     TEXT NOT NULL DEFAULT '',
  ADD COLUMN  "primaryImageUrl" TEXT,
  ADD COLUMN  "lineTotal"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN  "currency"        TEXT NOT NULL DEFAULT 'INR',
  ALTER COLUMN "productId"      DROP NOT NULL,
  ALTER COLUMN "productSku"     SET NOT NULL;

-- AlterTable: orders — Phase 08A fields
ALTER TABLE "orders"
  DROP COLUMN "refundedAmount",
  ADD COLUMN  "orderNumber"       TEXT NOT NULL DEFAULT '',
  ADD COLUMN  "paymentAttemptId"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN  "checkoutSessionId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN  "confirmedAt"       TIMESTAMP(3),
  ADD COLUMN  "cancelledAt"       TIMESTAMP(3),
  ADD COLUMN  "shippingName"       TEXT,
  ADD COLUMN  "shippingPhone"      TEXT,
  ADD COLUMN  "shippingLine1"      TEXT,
  ADD COLUMN  "shippingLine2"      TEXT,
  ADD COLUMN  "shippingCity"       TEXT,
  ADD COLUMN  "shippingState"      TEXT,
  ADD COLUMN  "shippingPostalCode" TEXT,
  ADD COLUMN  "shippingCountry"    TEXT,
  ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';

-- Harden User → Order FK to RESTRICT (financial history must not be destroyed)
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_userId_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex: orders
CREATE UNIQUE INDEX "orders_orderNumber_key"       ON "orders"("orderNumber");
CREATE UNIQUE INDEX "orders_paymentAttemptId_key"  ON "orders"("paymentAttemptId");
CREATE INDEX        "orders_checkoutSessionId_idx" ON "orders"("checkoutSessionId");

-- CreateIndex: order_items
CREATE INDEX "order_items_variantId_idx" ON "order_items"("variantId");

-- AddForeignKey: orders → checkout_sessions (RESTRICT)
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkoutSessionId_fkey"
  FOREIGN KEY ("checkoutSessionId") REFERENCES "checkout_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: orders → payment_attempts (RESTRICT)
ALTER TABLE "orders" ADD CONSTRAINT "orders_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: order_items → orders (CASCADE — items live and die with their order)
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: order_items → products (SET NULL — soft reference; snapshot is authoritative)
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: order_items → product_variants (SET NULL — soft reference)
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: audit_logs → orders (RESTRICT — audit records must not be lost)
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- PostgreSQL CHECK Constraints — financial integrity
-- These cannot be expressed in Prisma schema; applied directly in SQL.
-- =============================================================================

-- Order financial integrity
ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_total_positive"
  CHECK ("totalAmount" > 0);

ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_subtotal_positive"
  CHECK ("subtotal" > 0);

ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_tax_non_negative"
  CHECK ("tax" >= 0);

ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_discount_non_negative"
  CHECK ("discount" >= 0);

-- OrderItem financial integrity
ALTER TABLE "order_items" ADD CONSTRAINT "chk_order_items_qty_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "order_items" ADD CONSTRAINT "chk_order_items_price_non_neg"
  CHECK ("unitPrice" >= 0);

ALTER TABLE "order_items" ADD CONSTRAINT "chk_order_items_line_total"
  CHECK ("lineTotal" = "quantity" * "unitPrice");
