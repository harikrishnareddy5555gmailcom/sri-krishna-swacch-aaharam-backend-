-- Drop existing CASCADE foreign key constraints on payment_attempts
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_userId_fkey";
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_checkoutSessionId_fkey";

-- Add RESTRICT foreign key constraints to prevent accidental cascade deletion of historical payment records
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
