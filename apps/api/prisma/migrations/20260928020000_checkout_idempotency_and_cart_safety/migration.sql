-- AlterTable: add idempotencyKey and make cartId nullable
ALTER TABLE "checkout_sessions" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "checkout_sessions" ALTER COLUMN "cartId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "checkout_sessions" DROP CONSTRAINT "checkout_sessions_cartId_fkey";

-- AddForeignKey: Preserve historical checkout sessions when an operational cart is deleted
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: Client idempotency unique constraint (per user)
CREATE UNIQUE INDEX "checkout_sessions_userId_idempotencyKey_key" ON "checkout_sessions"("userId", "idempotencyKey");

-- CreateIndex: PostgreSQL partial unique index ensuring at most one ACTIVE checkout session per user/cart
CREATE UNIQUE INDEX "checkout_sessions_active_user_cart_idx" ON "checkout_sessions"("userId", "cartId") WHERE "status" = 'ACTIVE' AND "cartId" IS NOT NULL;
