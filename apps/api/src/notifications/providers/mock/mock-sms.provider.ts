import { Injectable, BadRequestException } from '@nestjs/common';
import {
  DeliveryStatus,
  type SmsInput,
  type ISmsProvider,
  type NormalizedDeliveryResult,
} from '@vishkaraa/types';
import {
  NormalizedProviderError,
} from '../notification-provider.interface.js';

@Injectable()
export class MockSmsProvider implements ISmsProvider {
  public readonly providerName = 'MOCK_SMS';

  private readonly maxStoredHistory = 500;
  private readonly sentMessages: SmsInput[] = [];
  private readonly idempotencyCache = new Map<string, NormalizedDeliveryResult>();

  // Simulation controls for testing
  private simulatedRetryableFailure = false;
  private retryableFailureMessage = 'SMS gateway throttled (429 Too Many Requests)';
  private simulatedPermanentFailure = false;
  private permanentFailureMessage = 'Invalid or non-existent mobile number (400)';
  private nextError: NormalizedProviderError | null = null;

  public async sendSms(input: SmsInput): Promise<NormalizedDeliveryResult> {
    await Promise.resolve();
    this.validateInput(input);

    // 1. One-shot programmed error
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }

    // 2. Simulated persistent failure modes
    if (this.simulatedPermanentFailure) {
      throw new NormalizedProviderError({
        providerName: this.providerName,
        errorCode: 'INVALID_DESTINATION',
        message: this.permanentFailureMessage,
        isRetryable: false,
      });
    }

    if (this.simulatedRetryableFailure) {
      throw new NormalizedProviderError({
        providerName: this.providerName,
        errorCode: 'GATEWAY_THROTTLED',
        message: this.retryableFailureMessage,
        isRetryable: true,
      });
    }

    // 3. Provider idempotency: return cached result if already accepted
    const cached = this.idempotencyCache.get(input.idempotencyKey);
    if (cached) {
      return cached;
    }

    // 4. Successful delivery acceptance
    const result: NormalizedDeliveryResult = {
      providerName: this.providerName,
      providerMessageId: `mock-sms-${input.idempotencyKey}`,
      status: DeliveryStatus.SENT,
      acceptedAt: new Date(),
      metadata: {
        to: input.to,
        dltTemplateId: input.dltTemplateId ?? null,
      },
    };

    if (this.sentMessages.length >= this.maxStoredHistory) {
      this.sentMessages.shift(); // keep bounded history
    }
    this.sentMessages.push(input);
    this.idempotencyCache.set(input.idempotencyKey, result);

    return result;
  }

  private validateInput(input: SmsInput): void {
    if (!input) {
      throw new BadRequestException('SMS input cannot be empty');
    }
    // Accept standard Indian 10-digit or E.164 formats (+91XXXXXXXXXX or XXXXXXXXXX)
    const phoneRegex = /^\+?[0-9]{10,15}$/;
    const sanitizedTo = input.to ? input.to.replace(/[\s-]/g, '') : '';
    if (!sanitizedTo || !phoneRegex.test(sanitizedTo)) {
      throw new BadRequestException(`Invalid SMS recipient phone number: ${input.to}`);
    }

    if (!input.message || typeof input.message !== 'string' || !input.message.trim()) {
      throw new BadRequestException('SMS message cannot be empty');
    }
    if (input.message.length > 1600) {
      throw new BadRequestException('SMS message exceeds maximum allowed length of 1600 characters');
    }

    if (!input.idempotencyKey || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw new BadRequestException('SMS idempotencyKey cannot be empty');
    }
  }

  // ─── Test Inspection & Simulation Helpers ─────────────────────────────────

  public getSentMessages(): readonly SmsInput[] {
    return [...this.sentMessages];
  }

  public getSentMessageByIdempotencyKey(key: string): SmsInput | undefined {
    return this.sentMessages.find((m) => m.idempotencyKey === key);
  }

  public setNextError(error: NormalizedProviderError | null): void {
    this.nextError = error;
  }

  public simulateRetryableFailure(enabled: boolean, message = 'SMS gateway throttled (429 Too Many Requests)'): void {
    this.simulatedRetryableFailure = enabled;
    this.retryableFailureMessage = message;
  }

  public simulatePermanentFailure(enabled: boolean, message = 'Invalid or non-existent mobile number (400)'): void {
    this.simulatedPermanentFailure = enabled;
    this.permanentFailureMessage = message;
  }

  public clear(): void {
    this.sentMessages.length = 0;
    this.idempotencyCache.clear();
    this.simulatedRetryableFailure = false;
    this.simulatedPermanentFailure = false;
    this.nextError = null;
  }
}
