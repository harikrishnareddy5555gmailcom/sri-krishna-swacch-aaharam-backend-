import { Injectable, BadRequestException } from '@nestjs/common';
import { type IShippingProvider } from './shipping-provider.interface.js';
import { MockShippingProvider } from './mock/mock-shipping.provider.js';

@Injectable()
export class ShippingProviderRegistry {
  private readonly providers = new Map<string, IShippingProvider>();

  constructor(private readonly mockProvider: MockShippingProvider) {
    this.registerProvider(mockProvider);
  }

  public registerProvider(provider: IShippingProvider): void {
    this.providers.set(provider.providerName.toUpperCase(), provider);
  }

  public getProvider(providerName: string): IShippingProvider {
    if (!providerName || typeof providerName !== 'string') {
      throw new BadRequestException('Provider name must be provided');
    }

    const provider = this.providers.get(providerName.trim().toUpperCase());
    if (!provider) {
      throw new BadRequestException(`Unsupported or unregistered shipping provider: ${providerName}`);
    }

    return provider;
  }

  public hasProvider(providerName: string): boolean {
    return this.providers.has(providerName.trim().toUpperCase());
  }
}
