import type {
  ServiceabilityRequest,
  ServiceabilityResponse,
} from '@vishkaraa/types';

export { ServiceabilityRequest, ServiceabilityResponse };

export interface PincodeZoneInfo {
  pincode: string;
  district: string;
  state: string;
  zoneType: string; // "METRO" | "TIER2" | "SPECIAL" | "REMOTE"
  isServiceable: boolean;
}

export interface RateCardInfo {
  id?: string;
  minWeightKg: number;
  maxWeightKg: number;
  baseRate: number; // in INR
  perKgRate: number; // in INR
  expectedTransitDays: number;
}

export interface CarrierCandidateResult {
  carrierCode: string;
  carrierName: string;
  isServiceable: boolean;
  estimatedTransitHours: number;
  estimatedDaysRange: string;
  shippingCost: number; // in INR
  shippingCostPaise: number; // in paise
  isBulkFreight: boolean;
  city: string;
  state: string;
  district?: string;
  serviceNote?: string;
  score?: number; // (Courier Cost * 0.6) + (Estimated Transit Hours * 0.4)
}

/**
 * Modular Courier Adapter Base Class
 */
export abstract class BaseCourierAdapter {
  abstract readonly code: string;
  abstract readonly name: string;
  abstract readonly isSurfaceHeavy: boolean;

  /**
   * Evaluates serviceability, cost, and transit time for target pincode & weight.
   */
  abstract checkServiceability(
    request: ServiceabilityRequest,
    zoneInfo?: PincodeZoneInfo | null,
    rateCard?: RateCardInfo | null,
  ): Promise<CarrierCandidateResult | null>;
}
