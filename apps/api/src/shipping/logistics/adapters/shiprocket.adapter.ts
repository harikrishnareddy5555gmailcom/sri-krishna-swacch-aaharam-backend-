import {
  BaseCourierAdapter,
  type ServiceabilityRequest,
  type PincodeZoneInfo,
  type RateCardInfo,
  type CarrierCandidateResult,
} from '../interfaces/courier-adapter.interface.js';

/**
 * Shiprocket Multi-Carrier Logistics Aggregator Adapter
 *
 * Dynamically aggregates Shadowfax, DTDC, and regional carriers.
 */
export class ShiprocketCourierAdapter extends BaseCourierAdapter {
  readonly code = 'SHIPROCKET';
  readonly name = 'Shiprocket Smart Routing';
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
    const isSpecial = zoneInfo?.zoneType === 'SPECIAL';

    const weightKg = Math.max(0.5, weightGrams / 1000);
    const baseRate = rateCard?.baseRate ?? 62;
    const perKgRate = rateCard?.perKgRate ?? 28;

    let expectedDays = rateCard?.expectedTransitDays ?? (isMetro ? 2 : isSpecial ? 5 : 3);
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
      city: zoneInfo?.district || 'Aggregator Node',
      state: zoneInfo?.state || 'India',
      district: zoneInfo?.district,
      serviceNote: 'Automated multi-carrier rate arbitrage for express delivery.',
    };
  }
}
