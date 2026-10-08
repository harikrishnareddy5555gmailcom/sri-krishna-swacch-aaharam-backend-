-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "providerPaymentId" TEXT,
    "idempotencyKey" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_userId_idempotencyKey_key" ON "payment_attempts"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_attempts_userId_idx" ON "payment_attempts"("userId");

-- CreateIndex
CREATE INDEX "payment_attempts_checkoutSessionId_idx" ON "payment_attempts"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts"("status");

-- CreateIndex
CREATE INDEX "payment_attempts_providerOrderId_idx" ON "payment_attempts"("providerOrderId");

-- CreateIndex
CREATE INDEX "payment_attempts_createdAt_idx" ON "payment_attempts"("createdAt");

-- CreateIndex: Partial unique index ensuring at most one active (CREATED or PENDING) payment attempt per checkout session
CREATE UNIQUE INDEX "payment_attempts_active_checkout_idx" ON "payment_attempts"("checkoutSessionId") WHERE "status" IN ('CREATED', 'PENDING');

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "checkout_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
