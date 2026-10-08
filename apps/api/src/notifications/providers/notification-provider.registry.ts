import { Injectable, BadRequestException } from '@nestjs/common';
import {
  type IEmailProvider,
  type ISmsProvider,
} from '@vishkaraa/types';
import { MockEmailProvider } from './mock/mock-email.provider.js';
import { MockSmsProvider } from './mock/mock-sms.provider.js';

@Injectable()
export class NotificationProviderRegistry {
  private readonly emailProviders = new Map<string, IEmailProvider>();
  private readonly smsProviders = new Map<string, ISmsProvider>();

  constructor(
    private readonly mockEmailProvider: MockEmailProvider,
    private readonly mockSmsProvider: MockSmsProvider,
  ) {
    this.registerEmailProvider(mockEmailProvider);
    this.registerSmsProvider(mockSmsProvider);
  }

  // ─── Email Provider Management ────────────────────────────────────────────

  public registerEmailProvider(provider: IEmailProvider): void {
    if (!provider || !provider.providerName) {
      throw new BadRequestException('Invalid email provider registration: missing providerName');
    }
    this.emailProviders.set(provider.providerName.toUpperCase(), provider);
  }

  public getEmailProvider(providerName = 'MOCK_EMAIL'): IEmailProvider {
    if (!providerName || typeof providerName !== 'string') {
      throw new BadRequestException('Email provider name must be specified');
    }

    const provider = this.emailProviders.get(providerName.trim().toUpperCase());
    if (!provider) {
      throw new BadRequestException(`Unsupported or unregistered email provider: ${providerName}`);
    }

    return provider;
  }

  public hasEmailProvider(providerName: string): boolean {
    if (!providerName || typeof providerName !== 'string') return false;
    return this.emailProviders.has(providerName.trim().toUpperCase());
  }

  // ─── SMS Provider Management ──────────────────────────────────────────────

  public registerSmsProvider(provider: ISmsProvider): void {
    if (!provider || !provider.providerName) {
      throw new BadRequestException('Invalid SMS provider registration: missing providerName');
    }
    this.smsProviders.set(provider.providerName.toUpperCase(), provider);
  }

  public getSmsProvider(providerName = 'MOCK_SMS'): ISmsProvider {
    if (!providerName || typeof providerName !== 'string') {
      throw new BadRequestException('SMS provider name must be specified');
    }

    const provider = this.smsProviders.get(providerName.trim().toUpperCase());
    if (!provider) {
      throw new BadRequestException(`Unsupported or unregistered SMS provider: ${providerName}`);
    }

    return provider;
  }

  public hasSmsProvider(providerName: string): boolean {
    if (!providerName || typeof providerName !== 'string') return false;
    return this.smsProviders.has(providerName.trim().toUpperCase());
  }
}
