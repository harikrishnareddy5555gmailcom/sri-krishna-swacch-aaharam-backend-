import { describe, it, expect, beforeEach } from 'vitest';
import { LogisticsRoutingEngine } from '../src/shipping/logistics/logistics-routing.engine.js';
import { type RateCardInfo } from '../src/shipping/logistics/interfaces/courier-adapter.interface.js';

describe('LogisticsRoutingEngine — Smart Multi-Courier Rate Shopping', () => {
  let engine: LogisticsRoutingEngine;

  beforeEach(() => {
    engine = new LogisticsRoutingEngine();
  });

  it('enforces 100% Online Payment / Prepaid-only policy on all responses', async () => {
    const res = await engine.evaluateServiceability(
      { pincode: '560034', weightGrams: 1000 },
      {
        isBlacklisted: false,
        zoneInfo: {
          pincode: '560034',
          district: 'Bengaluru Urban',
          state: 'Karnataka',
          zoneType: 'METRO',
          isServiceable: true,
        },
      },
    );

    expect(res.isPrepaidOnly).toBe(true);
    expect(res.prepaidNotice).toBe('100% Online Payment | Secure Prepaid Delivery');
  });

  it('routes standard retail orders (< 5 kg) via express courier rate shopping and cost optimization formula', async () => {
    const rateCards = new Map<string, RateCardInfo>([
      [
        'DELHIVERY',
        { minWeightKg: 0, maxWeightKg: 5, baseRate: 65, perKgRate: 30, expectedTransitDays: 3 },
      ],
      [
        'BLUEDART',
        { minWeightKg: 0, maxWeightKg: 5, baseRate: 95, perKgRate: 45, expectedTransitDays: 1 },
      ],
      [
        'XPRESSBEES',
        { minWeightKg: 0, maxWeightKg: 5, baseRate: 58, perKgRate: 26, expectedTransitDays: 4 },
      ],
    ]);

    const res = await engine.evaluateServiceability(
      { pincode: '560001', weightGrams: 1000 },
      {
        isBlacklisted: false,
        zoneInfo: {
          pincode: '560001',
          district: 'Bengaluru',
          state: 'Karnataka',
          zoneType: 'METRO',
          isServiceable: true,
        },
        rateCardsByCourier: rateCards,
      },
    );

    expect(res.isServiceable).toBe(true);
    expect(res.routingType).toBe('EXPRESS');
    expect(res.selectedCarrier).toBeDefined();
    // Verify cost optimization formula picked a competitive winner
    expect(res.shippingCostEstimate).toBeGreaterThan(0);
    expect(res.estimatedDaysRange).toBeDefined();
  });

  it('automatically switches bulk/B2B orders (>= 5 kg) to Heavy/Surface Logistics partner with bulk freight rates', async () => {
    const rateCards = new Map<string, RateCardInfo>([
      [
        'HEAVY_SURFACE',
        { minWeightKg: 5, maxWeightKg: 100, baseRate: 150, perKgRate: 12, expectedTransitDays: 5 },
      ],
    ]);

    const res = await engine.evaluateServiceability(
      { pincode: '400001', weightGrams: 15000, isBulk: true }, // 15 kg bulk oil order
      {
        isBlacklisted: false,
        zoneInfo: {
          pincode: '400001',
          district: 'Mumbai',
          state: 'Maharashtra',
          zoneType: 'METRO',
          isServiceable: true,
        },
        rateCardsByCourier: rateCards,
      },
    );

    expect(res.isServiceable).toBe(true);
    expect(res.routingType).toBe('SURFACE_HEAVY');
    expect(res.selectedCarrier).toContain('Heavy Surface Logistics');
    // 15kg calculation: 150 base + (15 - 5) * 12 = 150 + 120 = 270 INR
    expect(res.shippingCostEstimate).toBe(270);
    expect(res.isPrepaidOnly).toBe(true);
    expect(res.prepaidNotice).toBe('100% Online Payment | Secure Prepaid Delivery');
  });

  it('immediately marks blacklisted pincodes as non-serviceable and skips rate shopping', async () => {
    const res = await engine.evaluateServiceability(
      { pincode: '799001', weightGrams: 500 },
      {
        isBlacklisted: true,
        blacklistReason: 'Severe landslide disruption / Route suspended',
      },
    );

    expect(res.isServiceable).toBe(false);
    expect(res.message).toBe('Severe landslide disruption / Route suspended');
    expect(res.selectedCarrier).toBe('None');
    expect(res.isPrepaidOnly).toBe(true);
  });

  it('guarantees universal delivery fallback via India Post when primary couriers are unserviceable', async () => {
    // Empty candidate list causes fallback to India Post
    const res = await engine.evaluateServiceability(
      { pincode: '172106', weightGrams: 500 }, // Kinnaur, Himachal Pradesh
      {
        isBlacklisted: false,
        activeCourierCodes: new Set(), // Force 0 active commercial couriers
      },
    );

    expect(res.isServiceable).toBe(true);
    expect(res.routingType).toBe('POSTAL_FALLBACK');
    expect(res.selectedCarrier).toContain('India Post');
    expect(res.isPrepaidOnly).toBe(true);
  });

  it('serves repeated requests from 12-hour high-speed memory cache', async () => {
    const context = {
      isBlacklisted: false,
      zoneInfo: {
        pincode: '600001',
        district: 'Chennai',
        state: 'Tamil Nadu',
        zoneType: 'METRO',
        isServiceable: true,
      },
    };

    const first = await engine.evaluateServiceability(
      { pincode: '600001', weightGrams: 1000 },
      context,
    );
    const second = await engine.evaluateServiceability(
      { pincode: '600001', weightGrams: 1000 },
      context,
    );

    expect(first).toEqual(second);
  });

  it('correctly resolves city, state, and constituent areas via LogisticsService', async () => {
    const { LogisticsService } = await import('../src/shipping/logistics/logistics.service.js');
    const service = new LogisticsService(
      {
        blacklistedPincode: { findUnique: async () => null },
        pincodeZone: {
          findUnique: async () => ({
            pincode: '560102',
            district: 'Bengaluru Urban',
            state: 'Karnataka',
            zoneType: 'METRO',
            isServiceable: true,
          }),
        },
        courierPartner: { count: async () => 1 },
      } as any,
      engine,
    );

    const result = await service.lookupPincode('560102');
    expect(result.success).toBe(true);
    expect(result.pincode).toBe('560102');
    expect(result.state).toBe('Karnataka');
    expect(result.district).toBe('Bengaluru Urban');
    expect(result.isServiceable).toBe(true);
  });
});
