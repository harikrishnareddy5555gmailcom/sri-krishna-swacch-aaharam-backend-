import {
  BaseCourierAdapter,
  type ServiceabilityRequest,
  type PincodeZoneInfo,
  type RateCardInfo,
  type CarrierCandidateResult,
} from '../interfaces/courier-adapter.interface.js';

/**
 * Xpressbees Logistics Adapter
 *
 * Cost-effective e-commerce express parcel network across Tier 1, 2, and 3 cities.
 */
export class XpressbeesCourierAdapter extends BaseCourierAdapter {
  readonly code = 'XPRESSBEES';
  readonly name = 'Xpressbees Express';
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
    const isSpecial = zoneInfo?.zoneType === 'SPECIAL' || zoneInfo?.zoneType === 'REMOTE';

    const weightKg = Math.max(0.5, weightGrams / 1000);
    // Budget-friendly base rate: Rs 58 base + Rs 26/kg
    const baseRate = rateCard?.baseRate ?? 58;
    const perKgRate = rateCard?.perKgRate ?? 26;

    let expectedDays = rateCard?.expectedTransitDays ?? (isMetro ? 3 : isSpecial ? 5 : 4);
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
      city: zoneInfo?.district || 'Hub Centre',
      state: zoneInfo?.state || 'India',
      district: zoneInfo?.district,
      serviceNote: 'Economical parcel delivery across semi-urban and metro hubs.',
    };
  }
}
