import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  type IShippingProvider,
  type CreateShipmentProviderInput,
  type CreateShipmentProviderResult,
  type NormalizedShipmentEvent,
} from '../shipping-provider.interface.js';
import { mapProviderStatusToCanonical } from '../shipping-status.mapper.js';

@Injectable()
export class MockShippingProvider implements IShippingProvider {
  public readonly providerName = 'MOCK';
  private readonly logger = new Logger(MockShippingProvider.name);
  public customSecret?: string;

  constructor(customSecret?: string) {
    this.customSecret = customSecret;
  }

  private getWebhookSecret(): string {
    return (
      this.customSecret ||
      process.env['SHIPPING_WEBHOOK_SECRET_MOCK'] ||
      'mock-shipping-webhook-secret-min-32-chars-long'
    );
  }

  public static generateSignature(body: Buffer | string, secret: string): string {
    const rawBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return createHmac('sha256', secret).update(rawBuffer).digest('hex');
  }

  async createShipment(input: CreateShipmentProviderInput): Promise<CreateShipmentProviderResult> {
    await Promise.resolve();
    const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
    const trackingNumber = `MCK-${randomSuffix}`;
    const providerShipmentId = `mock_shp_${randomSuffix.toLowerCase()}`;

    return {
      providerShipmentId,
      trackingNumber,
      carrierName: 'Mock Logistics Express',
      labelUrl: `https://shiprocket.co/tracking/${trackingNumber}`,
      manifestUrl: `https://shiprocket.co/tracking/${trackingNumber}/manifest`,
      rawResponse: {
        success: true,
        referenceId: input.shipmentNumber,
        assignedCourier: 'Mock Logistics',
      },
    };
  }

  async cancelShipment(providerShipmentId: string, _reason?: string): Promise<boolean> {
    await Promise.resolve();
    this.logger.log(`[MOCK PROVIDER] Cancelled shipment ${providerShipmentId}`);
    return true;
  }

  async fetchTracking(trackingNumber: string): Promise<NormalizedShipmentEvent> {
    await Promise.resolve();
    const now = new Date();
    return {
      provider: this.providerName,
      eventId: `poll_${Date.now()}`,
      eventType: 'TRACKING_POLL',
      trackingNumber,
      providerShipmentId: `mock_shp_${trackingNumber}`,
      providerStatus: 'IN_TRANSIT',
      canonicalStatus: mapProviderStatusToCanonical('IN_TRANSIT'),
      statusDescription: 'Package is currently moving through regional sorting facility',
      location: 'Central Distribution Hub, Bengaluru',
      eventTimestamp: now,
      rawPayload: { trackingNumber, status: 'IN_TRANSIT', time: now.toISOString() },
      signatureValid: true,
      hasPhysicalDispatchEvidence: true,
      dispatchMilestone: 'PICKED_UP',
    };
  }

  async verifyAndParseWebhook(
    headers: Record<string, string>,
    rawBody: Buffer | string,
  ): Promise<{ isValid: boolean; event: NormalizedShipmentEvent }> {
    await Promise.resolve();
    const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

    // Case-insensitive header lookup
    const signature =
      headers['x-shipping-signature'] ||
      headers['x-mock-signature'] ||
      headers['X-Shipping-Signature'] ||
      headers['X-Mock-Signature'] ||
      '';

    const secret = this.getWebhookSecret();
    const isValid = this.verifySignature(rawBuffer, signature, secret);

    let parsedPayload: Record<string, unknown>;
    try {
      parsedPayload = JSON.parse(rawBuffer.toString('utf8')) as Record<string, unknown>;
    } catch {
      parsedPayload = {};
    }

    const getString = (val: unknown): string | null => {
      if (typeof val === 'string') return val;
      if (typeof val === 'number') return String(val);
      return null;
    };

    const eventId =
      getString(parsedPayload['eventId']) ||
      headers['x-mock-event-id'] ||
      `mock_evt_${Date.now()}`;
    const eventType = getString(parsedPayload['eventType']) || 'STATUS_UPDATE';
    const trackingNumber = getString(parsedPayload['trackingNumber']);
    const providerShipmentId = getString(parsedPayload['providerShipmentId']);
    const providerStatus =
      getString(parsedPayload['status']) ||
      getString(parsedPayload['rawStatus']) ||
      'UNKNOWN';
    const canonicalStatus = mapProviderStatusToCanonical(providerStatus);
    const statusDescription =
      getString(parsedPayload['description']) ||
      `Status updated to ${providerStatus}`;
    const location = getString(parsedPayload['location']);
    const timestampStr = getString(parsedPayload['eventTimestamp']);
    const eventTimestamp = timestampStr ? new Date(timestampStr) : new Date();

    // Explicit physical dispatch evidence evaluation inside adapter boundary
    const TRUSTED_DISPATCH_MILESTONES = new Set([
      'PICKED_UP',
      'HANDOVER_TO_COURIER',
      'DISPATCHED',
      'DEPARTED_FACILITY',
    ]);

    const isCurrentDispatch = TRUSTED_DISPATCH_MILESTONES.has(providerStatus);

    const rawMilestone =
      getString(parsedPayload['dispatchMilestone']) ||
      getString(parsedPayload['physicalDispatchMilestone']) ||
      getString(parsedPayload['carrierMilestone']);
    const isExplicitMilestoneTrusted = rawMilestone
      ? TRUSTED_DISPATCH_MILESTONES.has(rawMilestone)
      : false;

    let historicalMilestoneFound: string | null = null;
    if (Array.isArray(parsedPayload['milestones'])) {
      for (const m of parsedPayload['milestones']) {
        const mStr =
          typeof m === 'string'
            ? m
            : typeof m === 'object' && m !== null && 'status' in m
              ? getString((m as Record<string, unknown>)['status'])
              : null;
        if (mStr && TRUSTED_DISPATCH_MILESTONES.has(mStr)) {
          historicalMilestoneFound = mStr;
          break;
        }
      }
    }

    const hasPhysicalDispatchEvidence =
      isCurrentDispatch || isExplicitMilestoneTrusted || Boolean(historicalMilestoneFound);

    const dispatchMilestone = isCurrentDispatch
      ? providerStatus
      : isExplicitMilestoneTrusted && rawMilestone
        ? rawMilestone
        : historicalMilestoneFound;

    return {
      isValid,
      event: {
        provider: this.providerName,
        eventId,
        eventType,
        trackingNumber,
        providerShipmentId,
        providerStatus,
        canonicalStatus,
        statusDescription,
        location,
        eventTimestamp,
        rawPayload: parsedPayload,
        signatureValid: isValid,
        hasPhysicalDispatchEvidence,
        dispatchMilestone,
      },
    };
  }

  public generateSignature(body: Buffer | string): string {
    const rawBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return createHmac('sha256', this.getWebhookSecret()).update(rawBuffer).digest('hex');
  }

  private verifySignature(rawBuffer: Buffer, signature: string, secret: string): boolean {
    if (!rawBuffer || !signature || !secret) {
      return false;
    }

    const expectedSignature = createHmac('sha256', secret).update(rawBuffer).digest('hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(signature, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }
}
