-- Phase 11: Inventory & Stock Integrity Migration
-- Enforces physical quantities, derived availability, CHECK constraints, and strict RESTRICT foreign keys.

-- 1. Create Enums
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'COMMITTED', 'RELEASED', 'EXPIRED');
CREATE TYPE "InventoryMovementType" AS ENUM (
    'INITIAL_STOCK',
    'CHECKOUT_RESERVED',
    'RESERVATION_RELEASED',
    'RESERVATION_EXPIRED',
    'ORDER_COMMITTED',
    'ORDER_CANCELLED',
    'ORDER_SHIPPED',
    'RETURN_RESTOCKED',
    'ADMIN_ADJUSTMENT_INCREASE',
    'ADMIN_ADJUSTMENT_DECREASE'
);

-- 2. Alter ReturnItem for Restocking tracking
ALTER TABLE "return_items" ADD COLUMN "isRestocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "return_items" ADD COLUMN "restockedAt" TIMESTAMP(3);

-- 3. Create Table: inventory_items
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "committed" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- 4. Create Table: inventory_reservations
CREATE TABLE "inventory_reservations" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "orderId" TEXT,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- 5. Create Table: inventory_movements
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "onHandAfter" INTEGER NOT NULL,
    "reservedAfter" INTEGER NOT NULL,
    "committedAfter" INTEGER NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- 6. Unique Indexes
CREATE UNIQUE INDEX "inventory_items_variantId_key" ON "inventory_items"("variantId");
CREATE UNIQUE INDEX "inventory_reservations_checkoutSessionId_variantId_key" ON "inventory_reservations"("checkoutSessionId", "variantId");
CREATE UNIQUE INDEX "inventory_movements_idempotencyKey_key" ON "inventory_movements"("idempotencyKey");

-- 7. Standard Indexes
CREATE INDEX "inventory_items_variantId_idx" ON "inventory_items"("variantId");
CREATE INDEX "inventory_reservations_checkoutSessionId_idx" ON "inventory_reservations"("checkoutSessionId");
CREATE INDEX "inventory_reservations_variantId_idx" ON "inventory_reservations"("variantId");
CREATE INDEX "inventory_reservations_status_expiresAt_idx" ON "inventory_reservations"("status", "expiresAt");
CREATE INDEX "inventory_movements_inventoryItemId_idx" ON "inventory_movements"("inventoryItemId");
CREATE INDEX "inventory_movements_variantId_idx" ON "inventory_movements"("variantId");
CREATE INDEX "inventory_movements_type_idx" ON "inventory_movements"("type");
CREATE INDEX "inventory_movements_referenceType_referenceId_idx" ON "inventory_movements"("referenceType", "referenceId");
CREATE INDEX "inventory_movements_createdAt_idx" ON "inventory_movements"("createdAt");

-- 8. Foreign Key Constraints (All ON DELETE RESTRICT)
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 9. CHECK Constraints (Database-Engine Non-Negativity & Consistency Guards)
ALTER TABLE "inventory_items" ADD CONSTRAINT "chk_inventory_on_hand_non_negative" CHECK ("onHand" >= 0);
ALTER TABLE "inventory_items" ADD CONSTRAINT "chk_inventory_reserved_non_negative" CHECK ("reserved" >= 0);
ALTER TABLE "inventory_items" ADD CONSTRAINT "chk_inventory_committed_non_negative" CHECK ("committed" >= 0);
ALTER TABLE "inventory_items" ADD CONSTRAINT "chk_inventory_available_non_negative" CHECK ("onHand" >= ("reserved" + "committed"));
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "chk_reservation_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "inventory_movements" ADD CONSTRAINT "chk_movement_delta_non_zero" CHECK ("quantityDelta" != 0);

-- 10. Zero Fabricated Stock Backfill for Existing Product Variants
INSERT INTO "inventory_items" ("id", "variantId", "onHand", "reserved", "committed", "lowStockThreshold", "version", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "id",
    0,
    0,
    0,
    5,
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "product_variants"
ON CONFLICT ("variantId") DO NOTHING;
