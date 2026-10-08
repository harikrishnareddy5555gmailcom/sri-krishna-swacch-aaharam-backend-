/**
 * Shipping & Fulfillment Domain Types — Phase 13
 */

export enum ShipmentStatus {
  CREATED = 'CREATED',
  PACKING = 'PACKING',
  PACKED = 'PACKED',
  READY_TO_SHIP = 'READY_TO_SHIP',
  SHIPPED = 'SHIPPED',
  IN_TRANSIT = 'IN_TRANSIT',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  DELIVERED = 'DELIVERED',
  DELIVERY_FAILED = 'DELIVERY_FAILED',
  RTO_INITIATED = 'RTO_INITIATED',
  RTO_DELIVERED = 'RTO_DELIVERED',
  CANCELLED = 'CANCELLED',
  LOST = 'LOST',
}

export interface ShipmentItemDto {
  id: string;
  shipmentId: string;
  orderItemId: string;
  variantId: string;
  productName: string;
  variantName?: string | null;
  productSku: string;
  quantity: number;
  createdAt: string;
}

export interface ShipmentEventDto {
  id: string;
  shipmentId: string;
  status: ShipmentStatus;
  statusCode?: string | null;
  description: string;
  location?: string | null;
  eventTimestamp: string;
  providerEventId?: string | null;
  isStale: boolean;
  rawPayload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ShipmentDto {
  id: string;
  shipmentNumber: string;
  orderId: string;
  userId: string;
  status: ShipmentStatus;
  previousStatus?: ShipmentStatus | null;
  carrierCode: string;
  carrierName: string;
  serviceType?: string | null;
  trackingNumber?: string | null;
  providerShipmentId?: string | null;

  // Logistics Dimensions
  weightGrams: number;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  isCod: boolean;
  codAmountPaise: number;

  // Label & Documentation
  labelUrl?: string | null;
  manifestUrl?: string | null;
  invoiceId?: string | null;

  // Lifecycle Timestamps
  packedAt?: string | null;
  shippedAt?: string | null;
  outForDeliveryAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  lastEventTimestamp?: string | null;

  // Concurrency & Reconciliation
  version: number;
  reconciliationRequired: boolean;
  reconciliationNotes?: string | null;

  items?: ShipmentItemDto[];
  events?: ShipmentEventDto[];

  createdAt: string;
  updatedAt: string;
}

export interface ShipmentWebhookEventDto {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  trackingNumber?: string | null;
  rawPayload: Record<string, unknown>;
  processedAt?: string | null;
  processingError?: string | null;
  createdAt: string;
}

// =============================================================================
// PHASE 13B.4: CUSTOMER RESPONSE BOUNDARY
// Minimal, customer-safe tracking and order information.
// Never exposes provider secrets, raw webhook payloads, internal reconciliation notes,
// internal audit logs, or unvalidated tracking URLs.
// =============================================================================

export interface CustomerShipmentItemDto {
  id: string;
  orderItemId: string;
  productName: string;
  variantName?: string | null;
  productSku: string;
  quantity: number;
}

export interface CustomerShipmentDto {
  id: string;
  shipmentNumber: string;
  orderId: string;
  status: ShipmentStatus;
  carrierName: string;
  serviceType?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  items: CustomerShipmentItemDto[];
  createdAt: string;
}

// =============================================================================
// PHASE 13B.4: ADMIN RESPONSE BOUNDARY
// Operational shipment and event data for administrative visibility.
// Omits raw webhook payloads and provider secrets/credentials.
// =============================================================================

export interface AdminShipmentEventDto {
  id: string;
  shipmentId: string;
  status: ShipmentStatus;
  statusCode?: string | null;
  description: string;
  location?: string | null;
  eventTimestamp: string;
  providerEventId?: string | null;
  isStale: boolean;
  createdAt: string;
}

export interface AdminShipmentDto {
  id: string;
  shipmentNumber: string;
  orderId: string;
  userId: string;
  status: ShipmentStatus;
  previousStatus?: ShipmentStatus | null;
  carrierCode: string;
  carrierName: string;
  serviceType?: string | null;
  trackingNumber?: string | null;
  providerShipmentId?: string | null;
  weightGrams: number;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  isCod: boolean;
  codAmountPaise: number;
  labelUrl?: string | null;
  manifestUrl?: string | null;
  invoiceId?: string | null;
  packedAt?: string | null;
  shippedAt?: string | null;
  outForDeliveryAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  lastEventTimestamp?: string | null;
  version: number;
  reconciliationRequired: boolean;
  reconciliationNotes?: string | null;
  items?: ShipmentItemDto[];
  events?: AdminShipmentEventDto[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminShipmentListDto {
  data: AdminShipmentDto[];
  total: number;
  page: number;
  limit: number;
}

export interface CreateShipmentItemInput {
  orderItemId: string;
  quantity: number;
}

export interface CreateShipmentInput {
  orderId: string;
  items: CreateShipmentItemInput[];
  carrierCode?: string | null | undefined;
  carrierName?: string | null | undefined;
  serviceType?: string | null | undefined;
  trackingNumber?: string | null | undefined;
  providerShipmentId?: string | null | undefined;
  weightGrams?: number | undefined;
  lengthCm?: number | null | undefined;
  widthCm?: number | null | undefined;
  heightCm?: number | null | undefined;
  isCod?: boolean | undefined;
  codAmountPaise?: number | undefined;
  labelUrl?: string | null | undefined;
  manifestUrl?: string | null | undefined;
  invoiceId?: string | null | undefined;
  idempotencyKey?: string | undefined;
}

export interface UpdateShipmentStatusInput {
  status: ShipmentStatus;
  reason?: string | undefined;
  location?: string | undefined;
  statusCode?: string | undefined;
  description?: string | undefined;
  eventTimestamp?: string | undefined;
  trackingNumber?: string | undefined;
}

export interface CancelShipmentInput {
  reason: string;
}

export interface ReconcileShipmentInput {
  notes: string;
  targetStatus?: ShipmentStatus | undefined;
}

export interface AdminListShipmentsQuery {
  page?: number | undefined;
  limit?: number | undefined;
  status?: ShipmentStatus | undefined;
  carrierCode?: string | undefined;
  provider?: string | undefined;
  trackingNumber?: string | undefined;
  orderId?: string | undefined;
  userId?: string | undefined;
  reconciliationRequired?: boolean | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  search?: string | undefined;
}

// =============================================================================
// LOGISTICS ROUTING & MULTI-COURIER ESTIMATOR (Phase 20D.9)
// =============================================================================

export interface ServiceabilityRequest {
  pincode: string;
  weightGrams?: number;
  isBulk?: boolean;
}

export interface ServiceabilityResponse {
  pincode: string;
  city: string;
  state: string;
  district?: string;
  isServiceable: boolean;
  selectedCarrier: string; // e.g. "Delhivery Express", "Surface Heavy Logistics"
  carrierCode?: string;
  estimatedDeliveryDate: string; // ISO String or readable date
  estimatedDaysRange: string; // e.g. "3 - 4 Days"
  shippingCostEstimate: number; // in INR
  shippingCostPaise: number; // in paise
  isPrepaidOnly: true;
  prepaidNotice: string; // "100% Online Payment | Secure Prepaid Delivery"
  routingType: 'EXPRESS' | 'SURFACE_HEAVY' | 'POSTAL_FALLBACK';
  message?: string;
}

export interface CourierPartnerDto {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  priority: number;
  isSurfaceHeavy: boolean;
  apiCredentials?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PincodeZoneDto {
  pincode: string;
  district: string;
  state: string;
  zoneType: string;
  isServiceable: boolean;
}

export interface RateCardDto {
  id: string;
  courierId: string;
  courierName?: string;
  minWeightKg: number;
  maxWeightKg: number;
  baseRate: number;
  perKgRate: number;
  expectedTransitDays: number;
}

export interface BlacklistedPincodeDto {
  pincode: string;
  reason: string;
  createdAt: string;
}

