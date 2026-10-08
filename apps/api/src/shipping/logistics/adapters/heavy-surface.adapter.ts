import {
  BaseCourierAdapter,
  type ServiceabilityRequest,
  type PincodeZoneInfo,
  type RateCardInfo,
  type CarrierCandidateResult,
} from '../interfaces/courier-adapter.interface.js';

/**
 * Heavy / Surface Cargo Logistics Adapter (B2B & Bulk Freight)
 *
 * Designed for orders >= 5 kg (e.g. 5-liter oil cans, wholesale cartons, bulk culinary packs).
 * Routes shipments via commercial surface cargo lines (V-Trans, Spoton, Rivigo, Delhivery Surface)
 * with significantly discounted per-kg freight rates and full transit insurance.
 */
export class HeavySurfaceCourierAdapter extends BaseCourierAdapter {
  readonly code = 'HEAVY_SURFACE';
  readonly name = 'Heavy Surface Logistics (V-Trans / Spoton / Rivigo)';
  readonly isSurfaceHeavy = true;

  async checkServiceability(
    request: ServiceabilityRequest,
    zoneInfo?: PincodeZoneInfo | null,
    rateCard?: RateCardInfo | null,
  ): Promise<CarrierCandidateResult | null> {
    const { pincode, weightGrams = 5000, isBulk = true } = request;
    const cleanPin = pincode.trim();

    if (!/^[1-9]\d{5}$/.test(cleanPin)) {
      return null;
    }

    const weightKg = Math.max(5.0, weightGrams / 1000);
    const isSpecial = zoneInfo?.zoneType === 'SPECIAL' || zoneInfo?.zoneType === 'REMOTE';

    // Bulk freight rates: lower per-kg freight (e.g. base Rs 150 for 5kg + Rs 12/kg beyond 5kg)
    const baseRate = rateCard?.baseRate ?? 150;
    const perKgRate = rateCard?.perKgRate ?? 12;
    const expectedDays = rateCard?.expectedTransitDays ?? (isSpecial ? 7 : 5);

    const excessWeight = Math.max(0, weightKg - 5.0);
    const shippingCost = Math.round(baseRate + excessWeight * perKgRate);
    const estimatedTransitHours = expectedDays * 24;

    return {
      carrierCode: this.code,
      carrierName: this.name,
      isServiceable: true,
      estimatedTransitHours,
      estimatedDaysRange: `${expectedDays} - ${expectedDays + 2} Business Days`,
      shippingCost,
      shippingCostPaise: shippingCost * 100,
      isBulkFreight: true,
      city: zoneInfo?.district || 'Commercial Freight Terminal',
      state: zoneInfo?.state || 'India',
      district: zoneInfo?.district,
      serviceNote: 'Heavy cargo surface transit with commercial dock handling & shrink-wrap palleting.',
    };
  }
}
