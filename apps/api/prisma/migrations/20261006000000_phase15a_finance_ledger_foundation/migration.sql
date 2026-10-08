-- =============================================================================
-- Phase 15A: Finance Ledger Foundation Migration
-- =============================================================================
-- Creates the double-entry accounting foundation:
--   financial_accounts
--   financial_transactions
--   financial_transaction_lines
--
-- Design:
--   - All monetary values in integer paise (INR). No floating-point.
--   - DB CHECK constraints enforce per-line debit/credit invariants.
--   - SUM(debit) == SUM(credit) enforced transactionally by application service.
--   - Foreign keys use RESTRICT to protect financial history.
--   - idempotencyKey is UNIQUE on financial_transactions.
--   - No existing table is altered (purely additive migration).
-- =============================================================================

-- 1. Create Enums
CREATE TYPE "FinancialAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
CREATE TYPE "FinancialAccountNormalBalance" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "FinancialTransactionType" AS ENUM ('SALE', 'PAYMENT', 'REFUND', 'EXPENSE', 'ADJUSTMENT', 'CREDIT_NOTE', 'VOID');
CREATE TYPE "FinancialTransactionStatus" AS ENUM ('DRAFT', 'POSTED', 'VOIDED');

-- 2. Create Table: financial_accounts
CREATE TABLE "financial_accounts" (
    "id"              TEXT NOT NULL,
    "code"            TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "type"            "FinancialAccountType" NOT NULL,
    "normalBalance"   "FinancialAccountNormalBalance" NOT NULL,
    "description"     TEXT,
    "isSystemAccount" BOOLEAN NOT NULL DEFAULT false,
    "isActive"        BOOLEAN NOT NULL DEFAULT true,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- 3. Create Table: financial_transactions
CREATE TABLE "financial_transactions" (
    "id"              TEXT NOT NULL,
    "transactionType" "FinancialTransactionType" NOT NULL,
    "status"          "FinancialTransactionStatus" NOT NULL DEFAULT 'DRAFT',
    "currency"        TEXT NOT NULL DEFAULT 'INR',
    "sourceType"      TEXT,
    "sourceId"        TEXT,
    "description"     TEXT NOT NULL,
    "idempotencyKey"  TEXT NOT NULL,
    "postedAt"        TIMESTAMP(3),
    "voidedAt"        TIMESTAMP(3),
    "voidReason"      TEXT,
    "voidedById"      TEXT,
    "createdById"     TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

-- 4. Create Table: financial_transaction_lines
CREATE TABLE "financial_transaction_lines" (
    "id"            TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId"     TEXT NOT NULL,
    "debitPaise"    INTEGER NOT NULL DEFAULT 0,
    "creditPaise"   INTEGER NOT NULL DEFAULT 0,
    "description"   TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_transaction_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_ftl_debit_non_negative"  CHECK ("debitPaise" >= 0),
    CONSTRAINT "chk_ftl_credit_non_negative" CHECK ("creditPaise" >= 0),
    CONSTRAINT "chk_ftl_not_both_sides"      CHECK (NOT ("debitPaise" > 0 AND "creditPaise" > 0)),
    CONSTRAINT "chk_ftl_not_both_zero"       CHECK ("debitPaise" > 0 OR "creditPaise" > 0)
);

-- 5. Indexes
CREATE UNIQUE INDEX "financial_accounts_code_key"                      ON "financial_accounts"("code");
CREATE INDEX "financial_accounts_code_idx"                             ON "financial_accounts"("code");
CREATE INDEX "financial_accounts_type_idx"                             ON "financial_accounts"("type");
CREATE INDEX "financial_accounts_isActive_idx"                         ON "financial_accounts"("isActive");

CREATE UNIQUE INDEX "financial_transactions_idempotencyKey_key"        ON "financial_transactions"("idempotencyKey");
CREATE INDEX "financial_transactions_transactionType_idx"              ON "financial_transactions"("transactionType");
CREATE INDEX "financial_transactions_status_idx"                       ON "financial_transactions"("status");
CREATE INDEX "financial_transactions_sourceType_sourceId_idx"          ON "financial_transactions"("sourceType", "sourceId");
CREATE INDEX "financial_transactions_idempotencyKey_idx"               ON "financial_transactions"("idempotencyKey");
CREATE INDEX "financial_transactions_postedAt_idx"                     ON "financial_transactions"("postedAt");
CREATE INDEX "financial_transactions_createdAt_idx"                    ON "financial_transactions"("createdAt");

CREATE INDEX "financial_transaction_lines_transactionId_idx"           ON "financial_transaction_lines"("transactionId");
CREATE INDEX "financial_transaction_lines_accountId_idx"               ON "financial_transaction_lines"("accountId");

-- 6. Foreign Key Constraints
ALTER TABLE "financial_transaction_lines"
    ADD CONSTRAINT "financial_transaction_lines_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "financial_transaction_lines"
    ADD CONSTRAINT "financial_transaction_lines_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Seed: Minimal Chart of Accounts (system accounts)
INSERT INTO "financial_accounts" ("id", "code", "name", "type", "normalBalance", "description", "isSystemAccount", "isActive", "updatedAt") VALUES
    (gen_random_uuid(), '1000', 'Cash & Bank',                   'ASSET',     'DEBIT',  'Cash on hand and bank balances',                           true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '1100', 'Payment Gateway Clearing',      'ASSET',     'DEBIT',  'Funds in transit via payment gateway',                     true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '1200', 'Accounts Receivable',           'ASSET',     'DEBIT',  'Amounts owed by customers for goods delivered',            true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '2000', 'Accounts Payable',              'LIABILITY', 'CREDIT', 'Amounts owed to suppliers and vendors',                    true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '2100', 'GST / Tax Payable',             'LIABILITY', 'CREDIT', 'Output GST collected, awaiting remittance',                true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '3000', 'Sales Revenue',                 'REVENUE',   'CREDIT', 'Revenue from product sales',                               true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '3100', 'Shipping Revenue',              'REVENUE',   'CREDIT', 'Shipping charges collected from customers',                 true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4000', 'Discounts & Returns Allowance', 'EXPENSE',   'DEBIT',  'Discounts granted and return allowances',                  true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4100', 'Refunds Issued',                'EXPENSE',   'DEBIT',  'Refund amounts returned to customers',                     true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5000', 'Operating Expenses',            'EXPENSE',   'DEBIT',  'General and administrative operating expenses',            true, true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5100', 'Cost of Goods Sold',            'EXPENSE',   'DEBIT',  'Direct cost of products sold',                            true, true, CURRENT_TIMESTAMP);
