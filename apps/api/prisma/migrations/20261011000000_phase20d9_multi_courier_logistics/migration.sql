-- CreateTable
CREATE TABLE "courier_partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "isSurfaceHeavy" BOOLEAN NOT NULL DEFAULT false,
    "apiCredentials" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pincode_zones" (
    "pincode" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zoneType" TEXT NOT NULL DEFAULT 'TIER2',
    "isServiceable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pincode_zones_pkey" PRIMARY KEY ("pincode")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "minWeightKg" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "maxWeightKg" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "baseRate" DOUBLE PRECISION NOT NULL,
    "perKgRate" DOUBLE PRECISION NOT NULL,
    "expectedTransitDays" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blacklisted_pincodes" (
    "pincode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklisted_pincodes_pkey" PRIMARY KEY ("pincode")
);

-- CreateIndex
CREATE UNIQUE INDEX "courier_partners_code_key" ON "courier_partners"("code");

-- CreateIndex
CREATE INDEX "courier_partners_code_idx" ON "courier_partners"("code");

-- CreateIndex
CREATE INDEX "courier_partners_isActive_idx" ON "courier_partners"("isActive");

-- CreateIndex
CREATE INDEX "pincode_zones_state_idx" ON "pincode_zones"("state");

-- CreateIndex
CREATE INDEX "pincode_zones_district_idx" ON "pincode_zones"("district");

-- CreateIndex
CREATE INDEX "rate_cards_courierId_idx" ON "rate_cards"("courierId");

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "courier_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
