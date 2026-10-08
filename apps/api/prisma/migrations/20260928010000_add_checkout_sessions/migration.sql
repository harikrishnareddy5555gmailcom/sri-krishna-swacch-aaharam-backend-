-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotal" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_item_snapshots" (
    "id" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productSku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "primaryImageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_item_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_sessions_userId_idx" ON "checkout_sessions"("userId");

-- CreateIndex
CREATE INDEX "checkout_sessions_cartId_idx" ON "checkout_sessions"("cartId");

-- CreateIndex
CREATE INDEX "checkout_sessions_status_idx" ON "checkout_sessions"("status");

-- CreateIndex
CREATE INDEX "checkout_sessions_expiresAt_idx" ON "checkout_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "checkout_item_snapshots_checkoutSessionId_idx" ON "checkout_item_snapshots"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "checkout_item_snapshots_productId_idx" ON "checkout_item_snapshots"("productId");

-- CreateIndex
CREATE INDEX "checkout_item_snapshots_productVariantId_idx" ON "checkout_item_snapshots"("productVariantId");

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_item_snapshots" ADD CONSTRAINT "checkout_item_snapshots_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "checkout_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_item_snapshots" ADD CONSTRAINT "checkout_item_snapshots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_item_snapshots" ADD CONSTRAINT "checkout_item_snapshots_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
