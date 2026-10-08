-- =============================================================================
-- Migration: 20261009000000_variant_package_size_and_media
-- Multi-Variant Package Size & Variant-Specific Media Engine
-- =============================================================================

-- 1. Add shared images array to products
ALTER TABLE "products" ADD COLUMN "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- 2. Add packageSize, imageUrl, mediaUrls, isDefault to product_variants
ALTER TABLE "product_variants" ADD COLUMN "packageSize" TEXT;
ALTER TABLE "product_variants" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "product_variants" ADD COLUMN "mediaUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "product_variants" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- 3. Create index for packageSize on product_variants
CREATE INDEX "product_variants_packageSize_idx" ON "product_variants"("packageSize");

-- 4. Backfill packageSize from name for existing variants
UPDATE "product_variants" SET "packageSize" = "name" WHERE "packageSize" IS NULL;
