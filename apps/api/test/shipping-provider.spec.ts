import { describe, it, expect } from 'vitest';
import { MockShippingProvider } from '../src/shipping/providers/mock/mock-shipping.provider.js';
import { mapProviderStatusToCanonical } from '../src/shipping/providers/shipping-status.mapper.js';
import { validateTrackingUrl } from '../src/shipping/providers/tracking-url.util.js';
import {
  ShippingProviderError,
  ShippingProviderErrorCode,
} from '../src/shipping/providers/shipping-provider.errors.js';
import { ShipmentStatus } from '@prisma/client';

describe('Phase 13B.3 — Shipping Provider Abstraction & Utility Unit Tests', () => {
  const testSecret = 'mock-shipping-webhook-secret-key-32chars';
  const provider = new MockShippingProvider(testSecret);

  describe('1. IShippingProvider Contract & Mock Implementation', () => {
    it('has provider identifier MOCK', () => {
      expect(provider.providerName).toBe('MOCK');
    });

    it('creates a shipment and returns tracking and label URL', async () => {
      const res = await provider.createShipment({
        shipmentNumber: 'SHP-20261001-0001',
        orderNumber: 'ORD-20261001-0001',
        recipientName: 'Jane Doe',
        shippingAddress: {
          addressLine1: '456 Customer St',
          city: 'Mumbai',
          state: 'Maharashtra',
          postalCode: '400001',
          country: 'IN',
          phone: '9876543210',
        },
        items: [
          {
            sku: 'SKU-001',
            productName: 'Herbal Shampoo',
            quantity: 2,
            unitPricePaise: 49900,
          },
        ],
        totalWeightGrams: 1000,
        isCod: false,
      });

      expect(res.providerShipmentId).toMatch(/^mock_shp_/);
      expect(res.trackingNumber).toMatch(/^MCK-/);
      expect(res.carrierName).toBe('Mock Logistics Express');
      expect(res.labelUrl).toContain('https://shiprocket.co/tracking/');
    });

    it('cancels shipment successfully', async () => {
      const res = await provider.cancelShipment('mock_shp_12345');
      expect(res).toBe(true);
    });

    it('fetches tracking info', async () => {
      const info = await provider.fetchTracking('MCK-999');
      expect(info.trackingNumber).toBe('MCK-999');
      expect(info.canonicalStatus).toBe(ShipmentStatus.IN_TRANSIT);
      expect(info.providerStatus).toBe('IN_TRANSIT');
      expect(info.signatureValid).toBe(true);
    });
  });

  describe('2. Webhook Signature Verification (HMAC-SHA256 & Timing-Safe)', () => {
    it('verifies valid HMAC-SHA256 signature over raw Buffer bytes', async () => {
      const payload = JSON.stringify({ eventId: 'evt-001', status: 'IN_TRANSIT' });
      const rawBuffer = Buffer.from(payload, 'utf8');
      const sig = MockShippingProvider.generateSignature(rawBuffer, testSecret);

      const parsed = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': sig },
        rawBuffer,
      );
      expect(parsed.isValid).toBe(true);
      expect(parsed.event.signatureValid).toBe(true);
      expect(parsed.event.canonicalStatus).toBe(ShipmentStatus.IN_TRANSIT);
    });

    it('rejects tampered raw Buffer bytes', async () => {
      const payload = JSON.stringify({ eventId: 'evt-001', status: 'IN_TRANSIT' });
      const tampered = JSON.stringify({ eventId: 'evt-001', status: 'DELIVERED' });
      const sig = MockShippingProvider.generateSignature(Buffer.from(payload, 'utf8'), testSecret);

      const parsed = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': sig },
        Buffer.from(tampered, 'utf8'),
      );
      expect(parsed.isValid).toBe(false);
      expect(parsed.event.signatureValid).toBe(false);
    });

    it('rejects wrong secret', async () => {
      const payload = JSON.stringify({ eventId: 'evt-001' });
      const rawBuffer = Buffer.from(payload, 'utf8');
      const sig = MockShippingProvider.generateSignature(rawBuffer, 'incorrect-secret-key-32chars');

      const parsed = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': sig },
        rawBuffer,
      );
      expect(parsed.isValid).toBe(false);
    });

    it('rejects missing or empty signature header', async () => {
      const rawBuffer = Buffer.from('{}', 'utf8');
      const parsedMissing = await provider.verifyAndParseWebhook({}, rawBuffer);
      expect(parsedMissing.isValid).toBe(false);

      const parsedEmpty = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': '' },
        rawBuffer,
      );
      expect(parsedEmpty.isValid).toBe(false);
    });
  });

  describe('3. Normalization of Webhook Events', () => {
    it('normalizes valid raw payload', async () => {
      const rawPayload = {
        eventId: 'EVT-1001',
        shipmentId: 'ship-uuid-1',
        providerShipmentId: 'MOCK-SHP-123',
        trackingNumber: 'MOCK-TRK-456',
        status: 'OUT_FOR_DELIVERY',
        location: 'Hub Bengaluru',
        description: 'Out for delivery today',
        eventTimestamp: '2026-09-30T10:00:00.000Z',
      };
      const rawBuffer = Buffer.from(JSON.stringify(rawPayload), 'utf8');
      const sig = MockShippingProvider.generateSignature(rawBuffer, testSecret);

      const { event } = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': sig },
        rawBuffer,
      );
      expect(event.provider).toBe('MOCK');
      expect(event.eventId).toBe('EVT-1001');
      expect(event.providerShipmentId).toBe('MOCK-SHP-123');
      expect(event.trackingNumber).toBe('MOCK-TRK-456');
      expect(event.canonicalStatus).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
      expect(event.providerStatus).toBe('OUT_FOR_DELIVERY');
      expect(event.eventTimestamp).toEqual(new Date('2026-09-30T10:00:00.000Z'));
    });

    it('maps unknown courier status to null canonicalStatus', async () => {
      const rawPayload = {
        eventId: 'EVT-1002',
        shipmentId: 'ship-uuid-2',
        status: 'ALIEN_WAREHOUSE_HELD',
      };
      const rawBuffer = Buffer.from(JSON.stringify(rawPayload), 'utf8');
      const sig = MockShippingProvider.generateSignature(rawBuffer, testSecret);

      const { event } = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': sig },
        rawBuffer,
      );
      expect(event.canonicalStatus).toBeNull();
      expect(event.providerStatus).toBe('ALIEN_WAREHOUSE_HELD');
    });

    it('sets hasPhysicalDispatchEvidence = false when only tracking number or manifest status is present', async () => {
      const payloads = [
        {
          eventId: 'EVT-DISP-01',
          trackingNumber: 'MCK-TRACKING-ONLY-123',
          status: 'DELIVERED',
        },
        {
          eventId: 'EVT-DISP-02',
          trackingNumber: 'MCK-TRACKING-456',
          status: 'MANIFESTED',
        },
        {
          eventId: 'EVT-DISP-03',
          trackingNumber: 'MCK-TRACKING-789',
          status: 'ORDER_CREATED',
        },
        {
          eventId: 'EVT-DISP-04',
          trackingNumber: 'MCK-TRACKING-000',
          status: 'DATA_RECEIVED',
        },
      ];

      for (const p of payloads) {
        const rawBuffer = Buffer.from(JSON.stringify(p), 'utf8');
        const sig = MockShippingProvider.generateSignature(rawBuffer, testSecret);
        const { event } = await provider.verifyAndParseWebhook(
          { 'x-mock-signature': sig },
          rawBuffer,
        );
        expect(event.hasPhysicalDispatchEvidence).toBe(false);
        expect(event.dispatchMilestone).toBeNull();
      }
    });

    it('sets hasPhysicalDispatchEvidence = true when trusted dispatch milestone is present in status or milestone fields', async () => {
      // 1. Direct status is PICKED_UP
      const raw1 = Buffer.from(JSON.stringify({ eventId: 'E1', status: 'PICKED_UP' }), 'utf8');
      const res1 = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': MockShippingProvider.generateSignature(raw1, testSecret) },
        raw1,
      );
      expect(res1.event.hasPhysicalDispatchEvidence).toBe(true);
      expect(res1.event.dispatchMilestone).toBe('PICKED_UP');

      // 2. DELIVERED with explicit dispatchMilestone: HANDOVER_TO_COURIER
      const raw2 = Buffer.from(
        JSON.stringify({
          eventId: 'E2',
          status: 'DELIVERED',
          dispatchMilestone: 'HANDOVER_TO_COURIER',
        }),
        'utf8',
      );
      const res2 = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': MockShippingProvider.generateSignature(raw2, testSecret) },
        raw2,
      );
      expect(res2.event.hasPhysicalDispatchEvidence).toBe(true);
      expect(res2.event.dispatchMilestone).toBe('HANDOVER_TO_COURIER');

      // 3. DELIVERED with historical milestones array containing DISPATCHED
      const raw3 = Buffer.from(
        JSON.stringify({
          eventId: 'E3',
          status: 'DELIVERED',
          milestones: ['BOOKING_CREATED', 'MANIFESTED', 'DISPATCHED', 'OUT_FOR_DELIVERY'],
        }),
        'utf8',
      );
      const res3 = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': MockShippingProvider.generateSignature(raw3, testSecret) },
        raw3,
      );
      expect(res3.event.hasPhysicalDispatchEvidence).toBe(true);
      expect(res3.event.dispatchMilestone).toBe('DISPATCHED');
    });

    it('rejects unknown or arbitrary payload fields from being interpreted as dispatch evidence', async () => {
      const untrustedPayload = {
        eventId: 'E-UNTRUSTED',
        trackingNumber: 'MCK-UNTRUSTED-123',
        status: 'DELIVERED',
        // Untrusted/arbitrary fields:
        dispatched: true,
        hasLeftWarehouse: true,
        arbitraryCourierFlag: 'YES',
        carrierStatusNote: 'Package definitely left building',
      };
      const rawBuffer = Buffer.from(JSON.stringify(untrustedPayload), 'utf8');
      const sig = MockShippingProvider.generateSignature(rawBuffer, testSecret);
      const { event } = await provider.verifyAndParseWebhook(
        { 'x-mock-signature': sig },
        rawBuffer,
      );
      expect(event.hasPhysicalDispatchEvidence).toBe(false);
      expect(event.dispatchMilestone).toBeNull();
    });
  });

  describe('4. Status Mapping (Canonical 13-State Machine)', () => {
    it('maps known provider statuses correctly to canonical enum', () => {
      expect(mapProviderStatusToCanonical('MANIFESTED')).toBe(ShipmentStatus.READY_TO_SHIP);
      expect(mapProviderStatusToCanonical('PICKED_UP')).toBe(ShipmentStatus.SHIPPED);
      expect(mapProviderStatusToCanonical('IN_TRANSIT')).toBe(ShipmentStatus.IN_TRANSIT);
      expect(mapProviderStatusToCanonical('OUT_FOR_DELIVERY')).toBe(
        ShipmentStatus.OUT_FOR_DELIVERY,
      );
      expect(mapProviderStatusToCanonical('DELIVERED')).toBe(ShipmentStatus.DELIVERED);
      expect(mapProviderStatusToCanonical('UNDELIVERED')).toBe(ShipmentStatus.DELIVERY_FAILED);
      expect(mapProviderStatusToCanonical('RTO_INITIATED')).toBe(ShipmentStatus.RTO_INITIATED);
      expect(mapProviderStatusToCanonical('RTO_DELIVERED')).toBe(ShipmentStatus.RTO_DELIVERED);
      expect(mapProviderStatusToCanonical('CANCELLED')).toBe(ShipmentStatus.CANCELLED);
      expect(mapProviderStatusToCanonical('LOST')).toBe(ShipmentStatus.LOST);
    });

    it('returns null for unknown provider statuses without guessing', () => {
      expect(mapProviderStatusToCanonical('SOME_WEIRD_EVENT')).toBeNull();
      expect(mapProviderStatusToCanonical('')).toBeNull();
      expect(mapProviderStatusToCanonical(null as any)).toBeNull();
      expect(mapProviderStatusToCanonical(undefined as any)).toBeNull();
    });
  });

  describe('5. Tracking URL Validation (SSRF & Protocol Security)', () => {
    it('accepts valid HTTPS URL matching allowlisted provider domain', () => {
      const validUrl = 'https://tracking.mockcourier.local/track/MOCK-12345';
      expect(validateTrackingUrl(validUrl)).toBe(true);
    });

    it('accepts valid HTTPS URL with custom approved domains', () => {
      const validUrl = 'https://shiprocket.co/tracking/SR-12345';
      expect(validateTrackingUrl(validUrl)).toBe(true);
    });

    it('rejects HTTP (non-TLS) URLs', () => {
      expect(validateTrackingUrl('http://tracking.mockcourier.local/track/123')).toBe(false);
    });

    it('rejects javascript: pseudo-protocol', () => {
      expect(validateTrackingUrl('javascript:alert(1)')).toBe(false);
    });

    it('rejects data: URLs', () => {
      expect(validateTrackingUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    });

    it('rejects unapproved/arbitrary third-party domains', () => {
      expect(validateTrackingUrl('https://evil-hacker.com/track')).toBe(false);
      expect(validateTrackingUrl('https://tracking.mockcourier.local.evil.com/track')).toBe(false);
    });

    it('rejects malformed or empty URLs', () => {
      expect(validateTrackingUrl('')).toBe(false);
      expect(validateTrackingUrl('not-a-url')).toBe(false);
    });
  });

  describe('6. Provider Error Normalization', () => {
    it('constructs ShippingProviderError with error code and details', () => {
      const err = new ShippingProviderError(
        'Courier API 429 Too Many Requests',
        ShippingProviderErrorCode.RATE_LIMITED,
        'MOCK',
        429,
        { retryAfterSeconds: 60 },
      );

      expect(err.code).toBe(ShippingProviderErrorCode.RATE_LIMITED);
      expect(err.message).toBe('[MOCK] RATE_LIMITED: Courier API 429 Too Many Requests');
      expect(err.providerName).toBe('MOCK');
      expect(err.statusCode).toBe(429);
      expect(err.details).toEqual({ retryAfterSeconds: 60 });
      expect(err.name).toBe('ShippingProviderError');
    });

    it('supports all required failure categories', () => {
      const codes = Object.values(ShippingProviderErrorCode);
      expect(codes).toContain(ShippingProviderErrorCode.AUTHENTICATION_ERROR);
      expect(codes).toContain(ShippingProviderErrorCode.VALIDATION_ERROR);
      expect(codes).toContain(ShippingProviderErrorCode.UNAVAILABLE);
      expect(codes).toContain(ShippingProviderErrorCode.TIMEOUT);
      expect(codes).toContain(ShippingProviderErrorCode.RATE_LIMITED);
      expect(codes).toContain(ShippingProviderErrorCode.NOT_FOUND);
      expect(codes).toContain(ShippingProviderErrorCode.UNSUPPORTED_OPERATION);
      expect(codes).toContain(ShippingProviderErrorCode.UNKNOWN);
    });
  });
});
