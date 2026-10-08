-- =============================================================================
-- Phase 15C: Expenses Domain Foundation Migration
-- =============================================================================
-- Creates the operational expenses domain tables:
--   expenses
--   expense_attachments
--
-- Design:
--   - amountPaise integer positive amount in paise (INR).
--   - status: DRAFT -> SUBMITTED -> APPROVED -> POSTED (or REJECTED, CANCELLED).
--   - financeTransactionId: 1-to-1 unique linkage with financial_transactions.
--   - Soft actor references for submitter/approver/rejecter/canceller/poster.
-- =============================================================================

-- 1. Create Enums
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'CANCELLED');
CREATE TYPE "ExpensePaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'NET_BANKING', 'CHEQUE', 'OTHER');

-- 2. Create Table: expenses
CREATE TABLE "expenses" (
    "id"                    TEXT NOT NULL,
    "expenseNumber"         TEXT NOT NULL,
    "status"                "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "category"              TEXT NOT NULL,
    "vendor"                TEXT NOT NULL,
    "description"           TEXT NOT NULL,
    "amountPaise"           INTEGER NOT NULL,
    "currency"              TEXT NOT NULL DEFAULT 'INR',
    "expenseDate"           TIMESTAMP(3) NOT NULL,
    "expenseAccountId"      TEXT,
    "isPaid"                BOOLEAN NOT NULL DEFAULT true,
    "paymentMethod"         "ExpensePaymentMethod",
    "paymentReference"      TEXT,
    "paymentDate"           TIMESTAMP(3),
    "receiptUrl"            TEXT,
    "notes"                 TEXT,

    "submittedById"         TEXT,
    "submittedAt"           TIMESTAMP(3),
    "approvedById"          TEXT,
    "approvedAt"            TIMESTAMP(3),
    "rejectedById"          TEXT,
    "rejectedAt"            TIMESTAMP(3),
    "rejectionReason"       TEXT,
    "cancelledById"         TEXT,
    "cancelledAt"           TIMESTAMP(3),
    "cancellationReason"    TEXT,
    "postedById"            TEXT,
    "postedAt"              TIMESTAMP(3),

    "financeTransactionId"  TEXT,

    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_exp_amount_positive" CHECK ("amountPaise" > 0)
);

-- 3. Create Table: expense_attachments
CREATE TABLE "expense_attachments" (
    "id"            TEXT NOT NULL,
    "expenseId"     TEXT NOT NULL,
    "fileName"      TEXT NOT NULL,
    "fileUrl"       TEXT NOT NULL,
    "fileSize"      INTEGER,
    "mimeType"      TEXT,
    "uploadedById"  TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_attachments_pkey" PRIMARY KEY ("id")
);

-- 4. Indexes & Unique Constraints
CREATE UNIQUE INDEX "expenses_expenseNumber_key"          ON "expenses"("expenseNumber");
CREATE UNIQUE INDEX "expenses_financeTransactionId_key"   ON "expenses"("financeTransactionId");
CREATE INDEX "expenses_expenseNumber_idx"                 ON "expenses"("expenseNumber");
CREATE INDEX "expenses_status_idx"                        ON "expenses"("status");
CREATE INDEX "expenses_category_idx"                      ON "expenses"("category");
CREATE INDEX "expenses_vendor_idx"                        ON "expenses"("vendor");
CREATE INDEX "expenses_expenseDate_idx"                   ON "expenses"("expenseDate");
CREATE INDEX "expenses_submittedById_idx"                 ON "expenses"("submittedById");
CREATE INDEX "expenses_financeTransactionId_idx"          ON "expenses"("financeTransactionId");
CREATE INDEX "expenses_createdAt_idx"                     ON "expenses"("createdAt");

CREATE INDEX "expense_attachments_expenseId_idx"          ON "expense_attachments"("expenseId");

-- 5. Foreign Key Constraints
ALTER TABLE "expenses"
    ADD CONSTRAINT "expenses_expenseAccountId_fkey"
    FOREIGN KEY ("expenseAccountId") REFERENCES "financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "expense_attachments"
    ADD CONSTRAINT "expense_attachments_expenseId_fkey"
    FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
