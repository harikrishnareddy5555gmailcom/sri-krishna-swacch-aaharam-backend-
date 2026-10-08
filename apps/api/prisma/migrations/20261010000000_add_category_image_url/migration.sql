-- Add optional imageUrl to categories table
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
