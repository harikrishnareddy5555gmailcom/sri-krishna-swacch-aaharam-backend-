import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service.js';
import { ShippingProviderRegistry } from '../providers/shipping-provider.registry.js';
import { ShipmentService } from '../shipping.service.js';

export interface WebhookProcessResult {
  received: boolean;
  status: string;
  shipmentId?: string;
  eventId?: string;
}

@Injectable()
export class ShippingWebhookService {
  private readonly logger = new Logger(ShippingWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerRegistry: ShippingProviderRegistry,
    private readonly shipmentService: ShipmentService,
  ) {}

  /**
   * Securely ingests and processes an inbound courier webhook event.
   *
   * @param providerName The external provider identifier (e.g. "MOCK", "SHIPROCKET", "DELHIVERY")
   * @param rawBody The unparsed request body Buffer
   * @param headers The HTTP request headers (including signature)
   * @returns Processing outcome
   */
  async processWebhook(
    providerName: string,
    rawBody: Buffer | string,
    headers: Record<string, string>,
  ): Promise<WebhookProcessResult> {
    // 1. Resolve registered provider adapter
    const provider = this.providerRegistry.getProvider(providerName);

    // 2. Verify signature and parse raw bytes into canonical NormalizedShipmentEvent
    const { isValid, event } = await provider.verifyAndParseWebhook(headers, rawBody);

    if (!isValid) {
      this.logger.warn(
        `[WEBHOOK] Invalid signature rejected for shipping provider ${providerName}`,
      );
      throw new BadRequestException('Invalid webhook signature');
    }

    // 3. Webhook Idempotency Check & Ledger Record
    let webhookEventRecord: { id: string };
    try {
      webhookEventRecord = await this.prisma.shipmentWebhookEvent.create({
        data: {
          provider: event.provider.toUpperCase(),
          eventId: event.eventId,
          eventType: event.eventType,
          trackingNumber: event.trackingNumber,
          rawPayload: event.rawPayload as Prisma.InputJsonValue,
        },
      });
    } catch (err: unknown) {
      // Prisma P2002: unique constraint violated on (provider, eventId)
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `[WEBHOOK] Duplicate webhook event ignored: ${event.provider}/${event.eventId}`,
        );
        return {
          received: true,
          status: 'DUPLICATE_IGNORED',
          eventId: event.eventId,
        };
      }
      throw err;
    }

    // 4. Find targeted Shipment
    const shipment = await this.shipmentService.findShipmentByTrackingOrProviderId(
      event.trackingNumber,
      event.providerShipmentId,
    );

    if (!shipment) {
      this.logger.warn(
        `[WEBHOOK] No shipment matched tracking=${event.trackingNumber} or providerId=${event.providerShipmentId}`,
      );

      await this.prisma.shipmentWebhookEvent.update({
        where: { id: webhookEventRecord.id },
        data: {
          processingError: `No shipment found for tracking=${event.trackingNumber || 'null'} / providerId=${event.providerShipmentId || 'null'}`,
        },
      });

      return {
        received: true,
        status: 'SHIPMENT_NOT_FOUND',
        eventId: event.eventId,
      };
    }

    // 5. Apply event to shipment state machine via ShipmentService
    const { outcome } = await this.shipmentService.applyWebhookTransition({
      shipmentId: shipment.id,
      event,
    });

    // 6. Mark webhook event as processed
    await this.prisma.shipmentWebhookEvent.update({
      where: { id: webhookEventRecord.id },
      data: {
        processedAt: new Date(),
      },
    });

    this.logger.log(
      `[WEBHOOK] Successfully processed ${event.provider}/${event.eventId} -> ${outcome} for shipment ${shipment.shipmentNumber}`,
    );

    return {
      received: true,
      status: outcome,
      shipmentId: shipment.id,
      eventId: event.eventId,
    };
  }
}
