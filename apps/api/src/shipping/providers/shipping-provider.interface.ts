import type { ShipmentStatus } from '@prisma/client';

export interface CreateShipmentProviderInput {
  shipmentNumber: string;
  orderNumber: string;
  recipientName: string;
  shippingAddress: {
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string | null;
  };
  items: Array<{
    sku: string;
    productName: string;
    variantName?: string | null;
    quantity: number;
    unitPricePaise: number;
  }>;
  totalWeightGrams: number;
  dimensionsCm?: {
    length: number;
    width: number;
    height: number;
  } | null;
  isCod: boolean;
  codAmountPaise?: number;
}

export interface CreateShipmentProviderResult {
  providerShipmentId: string;
  trackingNumber: string;
  carrierName: string;
  labelUrl?: string | null;
  manifestUrl?: string | null;
  rawResponse?: Record<string, unknown>;
}

export interface NormalizedShipmentEvent {
  provider: string;
  eventId: string;
  eventType: string;
  trackingNumber?: string | null;
  providerShipmentId?: string | null;
  providerStatus: string;
  canonicalStatus: ShipmentStatus | null;
  statusDescription: string;
  location?: string | null;
  eventTimestamp: Date;
  rawPayload: Record<string, unknown>;
  signatureValid: boolean;
  hasPhysicalDispatchEvidence: boolean;
  dispatchMilestone?: string | null;
}

export interface IShippingProvider {
  readonly providerName: string;

  /**
   * Register parcel and obtain AWB/tracking from provider
   */
  createShipment(input: CreateShipmentProviderInput): Promise<CreateShipmentProviderResult>;

  /**
   * Cancel booking with courier before physical dispatch
   */
  cancelShipment(providerShipmentId: string, reason?: string): Promise<boolean>;

  /**
   * Fetch on-demand tracking status
   */
  fetchTracking(trackingNumber: string): Promise<NormalizedShipmentEvent>;

  /**
   * Parse and verify inbound webhook signature and payload
   */
  verifyAndParseWebhook(
    headers: Record<string, string>,
    rawBody: Buffer | string,
  ): Promise<{ isValid: boolean; event: NormalizedShipmentEvent }>;
}
