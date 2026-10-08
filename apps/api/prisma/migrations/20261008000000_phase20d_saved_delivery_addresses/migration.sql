-- =============================================================================
-- Phase 20D.8.2A: Saved Delivery Addresses Foundation Migration
-- =============================================================================
-- Creates the user saved delivery addresses domain:
--   - AddressLabel enum ('HOME', 'WORK', 'OTHER')
--   - user_addresses table
--   - foreign key to users table with ON DELETE CASCADE
--   - standard indexes on userId and (userId, isDefault)
--   - PostgreSQL partial unique index ensuring at most one isDefault = true per user
-- =============================================================================

-- 1. Create Enum
CREATE TYPE "AddressLabel" AS ENUM ('HOME', 'WORK', 'OTHER');

-- 2. Create Table: user_addresses
CREATE TABLE "user_addresses" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "phone"         TEXT NOT NULL,
    "line1"         TEXT NOT NULL,
    "line2"         TEXT,
    "city"          TEXT NOT NULL,
    "state"         TEXT NOT NULL,
    "postalCode"    TEXT NOT NULL,
    "country"       TEXT NOT NULL DEFAULT 'IN',
    "landmark"      TEXT,
    "label"         "AddressLabel" NOT NULL DEFAULT 'HOME',
    "isDefault"     BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_addresses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 3. Create Standard Performance Indexes
CREATE INDEX "user_addresses_userId_idx" ON "user_addresses"("userId");
CREATE INDEX "user_addresses_userId_isDefault_idx" ON "user_addresses"("userId", "isDefault");

-- 4. Create Partial Unique Index for Single Default Address per User
-- Strictly guarantees at the PostgreSQL database engine level that no user can have multiple default addresses.
CREATE UNIQUE INDEX "user_addresses_user_default_unique" ON "user_addresses"("userId") WHERE ("isDefault" = true);
