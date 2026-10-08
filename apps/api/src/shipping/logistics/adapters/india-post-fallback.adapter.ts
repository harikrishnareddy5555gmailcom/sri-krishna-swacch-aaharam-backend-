import { Logger } from '@nestjs/common';
import {
  BaseCourierAdapter,
  type ServiceabilityRequest,
  type PincodeZoneInfo,
  type RateCardInfo,
  type CarrierCandidateResult,
} from '../interfaces/courier-adapter.interface.js';

interface PostalApiResponseItem {
  Message?: string;
  Status: string;
  PostOffice?: Array<{
    Name: string;
    District: string;
    State: string;
    Country: string;
    Pincode: string;
  }>;
}

/**
 * Universal Fallback Postal Engine
 *
 * Utilizes public India Post Pincode API (api.postalpincode.in) or algorithmic zone parsing
 * when primary commercial carrier APIs time out (> 1500ms) or hit quota limitations.
 */
export class IndiaPostFallbackAdapter extends BaseCourierAdapter {
  readonly code = 'INDIA_POST';
  readonly name = 'India Post Speed Post (Postal Fallback)';
  readonly isSurfaceHeavy = false;
  private readonly logger = new Logger(IndiaPostFallbackAdapter.name);

  async checkServiceability(
    request: ServiceabilityRequest,
    zoneInfo?: PincodeZoneInfo | null,
    rateCard?: RateCardInfo | null,
  ): Promise<CarrierCandidateResult | null> {
    const { pincode, weightGrams = 500 } = request;
    const cleanPin = pincode.trim();

    let city = zoneInfo?.district || 'Regional Hub';
    let state = zoneInfo?.state || 'India';
    let district = zoneInfo?.district || 'District Centre';

    // Attempt to query api.postalpincode.in with strict 1500ms timeout
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const res = await fetch(`https://api.postalpincode.in/pincode/${cleanPin}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = (await res.json()) as PostalApiResponseItem[];
        if (Array.isArray(data) && data[0]?.Status === 'Success' && data[0].PostOffice?.length) {
          const po = data[0].PostOffice[0]!;
          city = po.Name || city;
          district = po.District || district;
          state = po.State || state;
        }
      }
    } catch (err: unknown) {
      this.logger.debug(`India Post API lookup bypassed for ${cleanPin}: ${(err as Error).message}`);
      // Algorithmic regional fallback if remote endpoint failed
      if (!zoneInfo) {
        const regionalInfo = this.inferRegionFromPincode(cleanPin);
        state = regionalInfo.state;
        city = regionalInfo.city;
        district = regionalInfo.district;
      }
    }

    const weightKg = Math.max(0.5, weightGrams / 1000);
    // Base rate for Speed Post: ~Rs 55 base + Rs 25/kg, 4-6 transit days
    const baseRate = rateCard?.baseRate ?? 55;
    const perKgRate = rateCard?.perKgRate ?? 25;
    const expectedDays = rateCard?.expectedTransitDays ?? 5;

    const shippingCost = Math.round(baseRate + Math.max(0, weightKg - 0.5) * perKgRate);
    const estimatedTransitHours = expectedDays * 24;

    return {
      carrierCode: this.code,
      carrierName: this.name,
      isServiceable: true,
      estimatedTransitHours,
      estimatedDaysRange: `${expectedDays - 1} - ${expectedDays + 1} Business Days`,
      shippingCost,
      shippingCostPaise: shippingCost * 100,
      isBulkFreight: false,
      city,
      state,
      district,
      serviceNote: 'Speed Post universal postal reach across all Indian PIN codes.',
    };
  }

  private inferRegionFromPincode(pin: string): { state: string; city: string; district: string } {
    const firstDigit = pin[0];
    switch (firstDigit) {
      case '1':
        return { state: 'Delhi & NCR', city: 'North Region Hub', district: 'Delhi NCR' };
      case '2':
        return { state: 'Uttar Pradesh', city: 'Central-North Hub', district: 'Lucknow Region' };
      case '3':
        return { state: 'Rajasthan / Gujarat', city: 'Western Hub', district: 'West Region' };
      case '4':
        return { state: 'Maharashtra', city: 'Mumbai / Pune Region', district: 'West Region' };
      case '5':
        return { state: 'Andhra Pradesh / Telangana', city: 'Hyderabad Region', district: 'South Region' };
      case '6':
        return { state: 'Tamil Nadu / Kerala', city: 'Chennai / Kochi Region', district: 'South Region' };
      case '7':
        return { state: 'West Bengal & North-East', city: 'Kolkata Region', district: 'East Region' };
      case '8':
        return { state: 'Bihar / Jharkhand', city: 'Patna Region', district: 'East Region' };
      default:
        return { state: 'India', city: 'National Network', district: 'General Service' };
    }
  }
}
