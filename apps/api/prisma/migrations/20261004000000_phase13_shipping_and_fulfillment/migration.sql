-- Phase 13: Shipping & Fulfillment Domain Foundation Migration
-- Enforces multi-shipment models, carrier telemetry, CHECK constraints, and strict RESTRICT/CASCADE foreign keys.

-- 1. Create Enum
CREATE TYPE "ShipmentStatus" AS ENUM (
    'CREATED',
    'PACKING',
    'PACKED',
    'READY_TO_SHIP',
    'SHIPPED',
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'DELIVERY_FAILED',
    'RTO_INITIATED',
    'RTO_DELIVERED',
    'CANCELLED',
    'LOST'
);

-- 2. Create Table: shipments
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "shipmentNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "previousStatus" "ShipmentStatus",
    "carrierCode" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "serviceType" TEXT,
    "trackingNumber" TEXT,
    "providerShipmentId" TEXT,
    "weightGrams" INTEGER NOT NULL DEFAULT 0,
    "lengthCm" INTEGER,
    "widthCm" INTEGER,
    "heightCm" INTEGER,
    "isCod" BOOLEAN NOT NULL DEFAULT false,
    "codAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "labelUrl" TEXT,
    "manifestUrl" TEXT,
    "invoiceId" TEXT,
    "packedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "outForDeliveryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "lastEventTimestamp" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false,
    "reconciliationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- 3. Create Table: shipment_items
CREATE TABLE "shipment_items" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "productSku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_items_pkey" PRIMARY KEY ("id")
);

-- 4. Create Table: shipment_events
CREATE TABLE "shipment_events" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "statusCode" TEXT,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "providerEventId" TEXT,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- 5. Create Table: shipment_webhook_events
CREATE TABLE "shipment_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "rawPayload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- 6. Unique Constraints & Standard Indexes
CREATE UNIQUE INDEX "shipments_shipmentNumber_key" ON "shipments"("shipmentNumber");
CREATE UNIQUE INDEX "shipments_carrierCode_trackingNumber_key" ON "shipments"("carrierCode", "trackingNumber");
CREATE INDEX "shipments_orderId_idx" ON "shipments"("orderId");
CREATE INDEX "shipments_userId_idx" ON "shipments"("userId");
CREATE INDEX "shipments_status_idx" ON "shipments"("status");
CREATE INDEX "shipments_trackingNumber_idx" ON "shipments"("trackingNumber");
CREATE INDEX "shipments_createdAt_idx" ON "shipments"("createdAt");

CREATE UNIQUE INDEX "shipment_items_shipmentId_orderItemId_key" ON "shipment_items"("shipmentId", "orderItemId");
CREATE INDEX "shipment_items_shipmentId_idx" ON "shipment_items"("shipmentId");
CREATE INDEX "shipment_items_orderItemId_idx" ON "shipment_items"("orderItemId");
CREATE INDEX "shipment_items_variantId_idx" ON "shipment_items"("variantId");

CREATE INDEX "shipment_events_shipmentId_idx" ON "shipment_events"("shipmentId");
CREATE INDEX "shipment_events_eventTimestamp_idx" ON "shipment_events"("eventTimestamp");

CREATE UNIQUE INDEX "shipment_webhook_events_provider_eventId_key" ON "shipment_webhook_events"("provider", "eventId");
CREATE INDEX "shipment_webhook_events_provider_idx" ON "shipment_webhook_events"("provider");
CREATE INDEX "shipment_webhook_events_trackingNumber_idx" ON "shipment_webhook_events"("trackingNumber");
CREATE INDEX "shipment_webhook_events_createdAt_idx" ON "shipment_webhook_events"("createdAt");

-- 7. Foreign Key Constraints
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 8. CHECK Constraints (Database-Engine Non-Negativity & Positive Quantity Guards)
ALTER TABLE "shipments" ADD CONSTRAINT "chk_shipment_weight_non_negative" CHECK ("weightGrams" >= 0);
ALTER TABLE "shipments" ADD CONSTRAINT "chk_shipment_cod_amount_non_negative" CHECK ("codAmountPaise" >= 0);
ALTER TABLE "shipments" ADD CONSTRAINT "chk_shipment_version_positive" CHECK ("version" >= 1);
ALTER TABLE "shipment_items" ADD CONSTRAINT "chk_shipment_item_quantity_positive" CHECK ("quantity" > 0);
