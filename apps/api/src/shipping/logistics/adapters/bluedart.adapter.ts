import {
  BaseCourierAdapter,
  type ServiceabilityRequest,
  type PincodeZoneInfo,
  type RateCardInfo,
  type CarrierCandidateResult,
} from '../interfaces/courier-adapter.interface.js';

/**
 * Blue Dart Air Express Adapter
 *
 * Dedicated air freight courier prioritizing minimal transit duration for urban & metro corridors.
 */
export class BlueDartCourierAdapter extends BaseCourierAdapter {
  readonly code = 'BLUEDART';
  readonly name = 'Blue Dart Air Express';
  readonly isSurfaceHeavy = false;

  async checkServiceability(
    request: ServiceabilityRequest,
    zoneInfo?: PincodeZoneInfo | null,
    rateCard?: RateCardInfo | null,
  ): Promise<CarrierCandidateResult | null> {
    const { pincode, weightGrams = 500 } = request;
    const cleanPin = pincode.trim();

    if (!/^[1-9]\d{5}$/.test(cleanPin)) {
      return null;
    }

    const isMetro = zoneInfo?.zoneType === 'METRO';
    const isRemote = zoneInfo?.zoneType === 'REMOTE';

    // Blue Dart Air primarily serves Metro, Tier 1, and Tier 2 cities
    if (isRemote) {
      return null; // Not optimal for remote rural post offices
    }

    const weightKg = Math.max(0.5, weightGrams / 1000);
    // Air Express premium rate
    const baseRate = rateCard?.baseRate ?? 95;
    const perKgRate = rateCard?.perKgRate ?? 45;

    let expectedDays = rateCard?.expectedTransitDays ?? (isMetro ? 1 : 2);
    let shippingCost = Math.round(baseRate + Math.max(0, weightKg - 0.5) * perKgRate);

    const estimatedTransitHours = expectedDays * 24;

    return {
      carrierCode: this.code,
      carrierName: this.name,
      isServiceable: true,
      estimatedTransitHours,
      estimatedDaysRange: `${expectedDays} - ${expectedDays + 1} Days`,
      shippingCost,
      shippingCostPaise: shippingCost * 100,
      isBulkFreight: false,
      city: zoneInfo?.district || 'Metro Air Cargo',
      state: zoneInfo?.state || 'India',
      district: zoneInfo?.district,
      serviceNote: 'Next-flight-out priority air logistics for rapid delivery.',
    };
  }
}
