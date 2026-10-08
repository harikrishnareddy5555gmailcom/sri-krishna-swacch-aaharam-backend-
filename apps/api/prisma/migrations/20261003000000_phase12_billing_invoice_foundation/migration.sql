-- Phase 12: Billing & Invoice Foundation Migration
-- Enforces immutable financial snapshots, unique invoice numbering, CHECK constraints, and strict RESTRICT foreign keys.

-- 1. Create Enum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- 2. Create Table: invoices
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotal" INTEGER NOT NULL,
    "discountTotal" INTEGER NOT NULL DEFAULT 0,
    "shippingTotal" INTEGER NOT NULL DEFAULT 0,
    "taxTotal" INTEGER NOT NULL DEFAULT 0,
    "grandTotal" INTEGER NOT NULL,
    "billingName" TEXT,
    "billingPhone" TEXT,
    "billingLine1" TEXT,
    "billingLine2" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "billingPostalCode" TEXT,
    "billingCountry" TEXT,
    "billingSnapshot" JSONB,
    "sellerName" TEXT NOT NULL DEFAULT 'Vishkaraa Naturals Private Limited',
    "sellerAddressLine1" TEXT,
    "sellerAddressLine2" TEXT,
    "sellerCity" TEXT,
    "sellerState" TEXT,
    "sellerPostalCode" TEXT,
    "sellerCountry" TEXT NOT NULL DEFAULT 'IN',
    "sellerEmail" TEXT,
    "sellerPhone" TEXT,
    "sellerGstin" TEXT,
    "sellerSnapshot" JSONB,
    "customerGstin" TEXT,
    "placeOfSupply" TEXT,
    "taxJurisdiction" TEXT,
    "isReverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "invoiceType" TEXT NOT NULL DEFAULT 'REGULAR',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- 3. Create Table: invoice_items
CREATE TABLE "invoice_items" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "productSku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "taxableAmount" INTEGER NOT NULL,
    "taxAmount" INTEGER NOT NULL DEFAULT 0,
    "lineTotal" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "hsnSac" TEXT,
    "taxRate" INTEGER,
    "cgstAmount" INTEGER,
    "sgstAmount" INTEGER,
    "igstAmount" INTEGER,
    "cessAmount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- 4. Unique Indexes
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");
CREATE UNIQUE INDEX "invoices_orderId_key" ON "invoices"("orderId");

-- 5. Standard Indexes
CREATE INDEX "invoices_userId_idx" ON "invoices"("userId");
CREATE INDEX "invoices_status_idx" ON "invoices"("status");
CREATE INDEX "invoices_issuedAt_idx" ON "invoices"("issuedAt");
CREATE INDEX "invoices_createdAt_idx" ON "invoices"("createdAt");
CREATE INDEX "invoice_items_invoiceId_idx" ON "invoice_items"("invoiceId");
CREATE INDEX "invoice_items_productSku_idx" ON "invoice_items"("productSku");

-- 6. Foreign Key Constraints (All ON DELETE RESTRICT)
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. CHECK Constraints (Database-Engine Non-Negativity & Consistency Guards)
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoice_subtotal_non_negative" CHECK ("subtotal" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoice_discount_non_negative" CHECK ("discountTotal" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoice_shipping_non_negative" CHECK ("shippingTotal" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoice_tax_non_negative" CHECK ("taxTotal" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoice_grand_total_non_negative" CHECK ("grandTotal" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoice_grand_total_match" CHECK ("grandTotal" = ("subtotal" - "discountTotal" + "shippingTotal" + "taxTotal"));

ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_item_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_item_unit_price_non_negative" CHECK ("unitPrice" >= 0);
ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_item_discount_non_negative" CHECK ("discountAmount" >= 0);
ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_item_taxable_non_negative" CHECK ("taxableAmount" >= 0);
ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_item_tax_non_negative" CHECK ("taxAmount" >= 0);
ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_item_line_total_non_negative" CHECK ("lineTotal" >= 0);
ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_item_line_total_match" CHECK ("lineTotal" = ("taxableAmount" + "taxAmount"));

-- 8. Phase 12 Explicit Choice A: Zero historical invoice backfill. Existing orders remain untouched.
