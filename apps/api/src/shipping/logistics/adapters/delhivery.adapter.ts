import {
  BaseCourierAdapter,
  type ServiceabilityRequest,
  type PincodeZoneInfo,
  type RateCardInfo,
  type CarrierCandidateResult,
} from '../interfaces/courier-adapter.interface.js';

/**
 * Delhivery Express Logistics Adapter
 *
 * High-speed express parcel network with coverage across 18,500+ Indian PIN codes.
 */
export class DelhiveryCourierAdapter extends BaseCourierAdapter {
  readonly code = 'DELHIVERY';
  readonly name = 'Delhivery Express';
  readonly isSurfaceHeavy = false;

  async checkServiceability(
    request: ServiceabilityRequest,
    zoneInfo?: PincodeZoneInfo | null,
    rateCard?: RateCardInfo | null,
  ): Promise<CarrierCandidateResult | null> {
    const { pincode, weightGrams = 500 } = request;
    const cleanPin = pincode.trim();

    // Standard serviceability: Indian PIN codes between 100000 and 999999
    if (!/^[1-9]\d{5}$/.test(cleanPin)) {
      return null;
    }

    const isMetro = zoneInfo?.zoneType === 'METRO';
    const isSpecial = zoneInfo?.zoneType === 'SPECIAL' || zoneInfo?.zoneType === 'REMOTE';

    const weightKg = Math.max(0.5, weightGrams / 1000);
    const baseRate = rateCard?.baseRate ?? 65;
    const perKgRate = rateCard?.perKgRate ?? 30;

    let expectedDays = rateCard?.expectedTransitDays ?? (isMetro ? 2 : isSpecial ? 5 : 3);
    let shippingCost = Math.round(baseRate + Math.max(0, weightKg - 0.5) * perKgRate);

    // Metro optimization (shorter transit)
    if (isMetro) {
      expectedDays = Math.max(2, expectedDays - 1);
    }

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
      city: zoneInfo?.district || 'Metro / City Centre',
      state: zoneInfo?.state || 'India',
      district: zoneInfo?.district,
      serviceNote: 'Automated express sorting with real-time GPS tracking.',
    };
  }
}
