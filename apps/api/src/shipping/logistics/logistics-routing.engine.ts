import { Injectable, Logger } from '@nestjs/common';
import {
  BaseCourierAdapter,
  type ServiceabilityRequest,
  type ServiceabilityResponse,
  type PincodeZoneInfo,
  type RateCardInfo,
  type CarrierCandidateResult,
} from './interfaces/courier-adapter.interface.js';
import { DelhiveryCourierAdapter } from './adapters/delhivery.adapter.js';
import { BlueDartCourierAdapter } from './adapters/bluedart.adapter.js';
import { XpressbeesCourierAdapter } from './adapters/xpressbees.adapter.js';
import { ShiprocketCourierAdapter } from './adapters/shiprocket.adapter.js';
import { HeavySurfaceCourierAdapter } from './adapters/heavy-surface.adapter.js';
import { IndiaPostFallbackAdapter } from './adapters/india-post-fallback.adapter.js';

interface CacheEntry {
  data: ServiceabilityResponse;
  expiresAt: number;
}

/**
 * Enterprise Multi-Courier Delivery Estimator & Smart Logistics Routing Engine
 *
 * Performs dynamic rate shopping, cost optimization algorithm, bulk switching,
 * universal postal fallback, and 12-hour high-speed caching.
 */
@Injectable()
export class LogisticsRoutingEngine {
  private readonly logger = new Logger(LogisticsRoutingEngine.name);

  // Adapters registry
  private readonly expressAdapters: BaseCourierAdapter[];
  private readonly heavySurfaceAdapter: BaseCourierAdapter;
  private readonly postalFallbackAdapter: IndiaPostFallbackAdapter;

  // 12-hour in-memory cache (pincode + weight bucket -> ServiceabilityResponse)
  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

  constructor() {
    this.expressAdapters = [
      new DelhiveryCourierAdapter(),
      new BlueDartCourierAdapter(),
      new XpressbeesCourierAdapter(),
      new ShiprocketCourierAdapter(),
    ];
    this.heavySurfaceAdapter = new HeavySurfaceCourierAdapter();
    this.postalFallbackAdapter = new IndiaPostFallbackAdapter();
  }

  /**
   * Main Routing Method:
   * Selects optimal logistics partner and returns delivery estimate.
   */
  async evaluateServiceability(
    request: ServiceabilityRequest,
    context: {
      isBlacklisted: boolean;
      blacklistReason?: string | null;
      zoneInfo?: PincodeZoneInfo | null;
      rateCardsByCourier?: Map<string, RateCardInfo>;
      activeCourierCodes?: Set<string>;
    },
  ): Promise<ServiceabilityResponse> {
    const pincode = request.pincode?.trim() || '';
    const weightGrams = request.weightGrams ?? 500;
    const isBulk = Boolean(request.isBulk || weightGrams >= 5000);

    // 1. PIN Code Format Check
    if (!/^[1-9]\d{5}$/.test(pincode)) {
      return {
        pincode,
        city: 'Unknown',
        state: 'Unknown',
        district: undefined,
        isServiceable: false,
        selectedCarrier: 'None',
        carrierCode: undefined,
        estimatedDeliveryDate: '',
        estimatedDaysRange: 'N/A',
        shippingCostEstimate: 0,
        shippingCostPaise: 0,
        isPrepaidOnly: true,
        prepaidNotice: '100% Online Payment | Secure Prepaid Delivery',
        routingType: 'EXPRESS',
        message: 'Invalid 6-digit Indian PIN code format.',
      };
    }

    // 2. Blacklist Check
    if (context.isBlacklisted) {
      return {
        pincode,
        city: context.zoneInfo?.district || 'Restricted Hub',
        state: context.zoneInfo?.state || 'India',
        district: context.zoneInfo?.district,
        isServiceable: false,
        selectedCarrier: 'None',
        carrierCode: undefined,
        estimatedDeliveryDate: '',
        estimatedDaysRange: 'Non-serviceable',
        shippingCostEstimate: 0,
        shippingCostPaise: 0,
        isPrepaidOnly: true,
        prepaidNotice: '100% Online Payment | Secure Prepaid Delivery',
        routingType: isBulk ? 'SURFACE_HEAVY' : 'EXPRESS',
        message:
          context.blacklistReason ||
          'Delivery temporarily unavailable for this PIN code due to regional logistics restrictions.',
      };
    }

    // 3. 12-Hour Cache Check (sub-20ms PDP performance)
    const weightBracketKg = Math.ceil(weightGrams / 500) * 0.5; // Bucket per 500g
    const cacheKey = `${pincode}:${weightBracketKg}:${isBulk ? 'bulk' : 'retail'}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    // 4. Determine Eligible Adapters
    let candidateAdapters: BaseCourierAdapter[];
    if (isBulk) {
      // Bulk / B2B orders (>= 5 kg) automatically switch to Heavy/Surface logistics partners
      candidateAdapters = [this.heavySurfaceAdapter];
    } else {
      // Retail parcel orders (< 5 kg) query express courier partners
      if (context.activeCourierCodes) {
        candidateAdapters = this.expressAdapters.filter((adapter) =>
          context.activeCourierCodes!.has(adapter.code),
        );
      } else {
        candidateAdapters = this.expressAdapters;
      }
    }

    // 5. Query candidate adapters concurrently with strict 1500ms timeout per call
    const candidatePromises = candidateAdapters.map(async (adapter) => {
      const rateCard = context.rateCardsByCourier?.get(adapter.code) ?? null;
      try {
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), 1500),
        );
        const queryPromise = adapter.checkServiceability(
          { pincode, weightGrams, isBulk },
          context.zoneInfo,
          rateCard,
        );
        return await Promise.race([queryPromise, timeoutPromise]);
      } catch (err: unknown) {
        this.logger.warn(
          `Carrier adapter ${adapter.code} error for ${pincode}: ${(err as Error).message}`,
        );
        return null;
      }
    });

    const results = await Promise.all(candidatePromises);
    const validCandidates: CarrierCandidateResult[] = results.filter(
      (r): r is CarrierCandidateResult => r !== null && r.isServiceable,
    );

    let winner: CarrierCandidateResult;
    let routingType: 'EXPRESS' | 'SURFACE_HEAVY' | 'POSTAL_FALLBACK' = isBulk
      ? 'SURFACE_HEAVY'
      : 'EXPRESS';

    // 6. Cost Optimization Algorithm OR Universal Postal Fallback
    if (validCandidates.length > 0) {
      // Rank by: (Courier Cost * 0.6) + (Estimated Transit Hours * 0.4)
      validCandidates.forEach((candidate) => {
        candidate.score =
          candidate.shippingCost * 0.6 + candidate.estimatedTransitHours * 0.4;
      });

      validCandidates.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
      winner = validCandidates[0]!;
    } else {
      // Fallback Postal Engine (India Post) if primary couriers timed out or unserviceable
      routingType = 'POSTAL_FALLBACK';
      const postalRateCard = context.rateCardsByCourier?.get('INDIA_POST') ?? null;
      const fallbackResult = await this.postalFallbackAdapter.checkServiceability(
        { pincode, weightGrams, isBulk },
        context.zoneInfo,
        postalRateCard,
      );

      if (fallbackResult) {
        winner = fallbackResult;
      } else {
        // Universal safety guarantee
        winner = {
          carrierCode: 'INDIA_POST',
          carrierName: 'India Post Speed Post',
          isServiceable: true,
          estimatedTransitHours: 120,
          estimatedDaysRange: '4 - 6 Business Days',
          shippingCost: 60,
          shippingCostPaise: 6000,
          isBulkFreight: false,
          city: context.zoneInfo?.district || 'India Post Delivery Office',
          state: context.zoneInfo?.state || 'India',
          district: context.zoneInfo?.district,
          serviceNote: 'Standard national postal dispatch.',
        };
      }
    }

    // 7. Calculate Estimated Delivery Date
    const daysToAdd = Math.ceil(winner.estimatedTransitHours / 24);
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + daysToAdd);

    const formattedDate = deliveryDate.toLocaleDateString('en-IN', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    // 8. Construct Final Enforced Response
    const response: ServiceabilityResponse = {
      pincode,
      city: winner.city,
      state: winner.state,
      district: winner.district,
      isServiceable: true,
      selectedCarrier: winner.carrierName,
      carrierCode: winner.carrierCode,
      estimatedDeliveryDate: formattedDate,
      estimatedDaysRange: winner.estimatedDaysRange,
      shippingCostEstimate: winner.shippingCost,
      shippingCostPaise: winner.shippingCostPaise,
      isPrepaidOnly: true,
      prepaidNotice: '100% Online Payment | Secure Prepaid Delivery',
      routingType,
      message: winner.serviceNote,
    };

    // 9. Store in 12-hour cache
    this.cache.set(cacheKey, {
      data: response,
      expiresAt: now + this.CACHE_TTL_MS,
    });

    return response;
  }

  /**
   * Invalidate cache for a specific pincode or purge all
   */
  clearCache(pincode?: string): void {
    if (pincode) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${pincode}:`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }
}
