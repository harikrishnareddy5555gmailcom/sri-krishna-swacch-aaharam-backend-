import {
  Controller,
  Post,
  Param,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ShippingWebhookService } from './shipping-webhook.service.js';

@Controller('webhooks/shipping')
@SkipThrottle()
export class ShippingWebhookController {
  private readonly logger = new Logger(ShippingWebhookController.name);

  constructor(private readonly webhookService: ShippingWebhookService) {}

  /**
   * POST /api/v1/webhooks/shipping/:provider
   *
   * Ingests inbound webhook telemetry from shipping carriers.
   * Public endpoint authenticated via HMAC signature verification.
   *
   * Always returns 200 on:
   * - Successfully processed events
   * - Duplicate events (idempotent no-op)
   * - Replayed/stale events
   * - Quarantined / reconciliation-required events
   *
   * Returns 400 on:
   * - Non-buffer body (middleware misconfiguration)
   * - Missing or invalid HMAC signature
   * - Malformed payload
   */
  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  async handleShippingWebhook(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
  ): Promise<{ received: boolean; result: string; shipmentId?: string; eventId?: string }> {
    // 1. Guard against uncaptured raw body
    if (!Buffer.isBuffer(req.body)) {
      this.logger.error(
        `Webhook body for provider ${provider} is not a Buffer — express.raw() middleware must be configured for this route`,
      );
      throw new BadRequestException(
        'Webhook body must be raw bytes. Middleware misconfiguration detected.',
      );
    }

    const outcome = await this.webhookService.processWebhook(
      provider,
      req.body,
      headers,
    );

    return {
      received: outcome.received,
      result: outcome.status,
      shipmentId: outcome.shipmentId,
      eventId: outcome.eventId,
    };
  }
}
