import { Injectable, BadRequestException } from '@nestjs/common';
import {
  DeliveryStatus,
  type EmailInput,
  type IEmailProvider,
  type NormalizedDeliveryResult,
} from '@vishkaraa/types';
import {
  NormalizedProviderError,
} from '../notification-provider.interface.js';

@Injectable()
export class MockEmailProvider implements IEmailProvider {
  public readonly providerName = 'MOCK_EMAIL';

  private readonly sentEmails: EmailInput[] = [];
  private readonly idempotencyCache = new Map<string, NormalizedDeliveryResult>();

  // Simulation controls for testing
  private simulatedRetryableFailure = false;
  private retryableFailureMessage = 'Temporary SMTP connection timeout';
  private simulatedPermanentFailure = false;
  private permanentFailureMessage = 'Recipient mailbox does not exist (550)';
  private nextError: NormalizedProviderError | null = null;

  public async sendEmail(input: EmailInput): Promise<NormalizedDeliveryResult> {
    await Promise.resolve();
    this.validateInput(input);

    // 1. One-shot programmed error takes top priority
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }

    // 2. Simulated persistent failure modes
    if (this.simulatedPermanentFailure) {
      throw new NormalizedProviderError({
        providerName: this.providerName,
        errorCode: 'MAILBOX_NOT_FOUND',
        message: this.permanentFailureMessage,
        isRetryable: false,
      });
    }

    if (this.simulatedRetryableFailure) {
      throw new NormalizedProviderError({
        providerName: this.providerName,
        errorCode: 'CONNECTION_TIMEOUT',
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
      providerMessageId: `mock-email-${input.idempotencyKey}`,
      status: DeliveryStatus.SENT,
      acceptedAt: new Date(),
      metadata: {
        to: input.to,
        subject: input.subject,
        hasHtml: Boolean(input.htmlBody),
      },
    };

    this.sentEmails.push(input);
    this.idempotencyCache.set(input.idempotencyKey, result);

    return result;
  }

  private validateInput(input: EmailInput): void {
    if (!input) {
      throw new BadRequestException('Email input cannot be empty');
    }
    if (!input.to || typeof input.to !== 'string' || !input.to.includes('@')) {
      throw new BadRequestException(`Invalid email recipient: ${input.to}`);
    }
    if (!input.subject || typeof input.subject !== 'string' || !input.subject.trim()) {
      throw new BadRequestException('Email subject cannot be empty');
    }
    if (!input.textBody || typeof input.textBody !== 'string' || !input.textBody.trim()) {
      throw new BadRequestException('Email textBody cannot be empty');
    }
    if (!input.idempotencyKey || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw new BadRequestException('Email idempotencyKey cannot be empty');
    }
  }

  // ─── Test Inspection & Simulation Helpers ─────────────────────────────────

  public getSentEmails(): readonly EmailInput[] {
    return [...this.sentEmails];
  }

  public getSentEmailByIdempotencyKey(key: string): EmailInput | undefined {
    return this.sentEmails.find((e) => e.idempotencyKey === key);
  }

  public setNextError(error: NormalizedProviderError | null): void {
    this.nextError = error;
  }

  public simulateRetryableFailure(enabled: boolean, message = 'Temporary SMTP connection timeout'): void {
    this.simulatedRetryableFailure = enabled;
    this.retryableFailureMessage = message;
  }

  public simulatePermanentFailure(enabled: boolean, message = 'Recipient mailbox does not exist (550)'): void {
    this.simulatedPermanentFailure = enabled;
    this.permanentFailureMessage = message;
  }

  public clear(): void {
    this.sentEmails.length = 0;
    this.idempotencyCache.clear();
    this.simulatedRetryableFailure = false;
    this.simulatedPermanentFailure = false;
    this.nextError = null;
  }
}
