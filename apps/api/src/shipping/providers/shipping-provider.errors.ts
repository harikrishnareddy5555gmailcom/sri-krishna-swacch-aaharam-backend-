/**
 * Canonical error categories for external shipping courier providers.
 * Sanitizes external carrier exceptions before reaching application or domain layers.
 */
export enum ShippingProviderErrorCode {
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAVAILABLE = 'UNAVAILABLE',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  NOT_FOUND = 'NOT_FOUND',
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',
  UNKNOWN = 'UNKNOWN',
}

export class ShippingProviderError extends Error {
  public readonly code: ShippingProviderErrorCode;
  public readonly providerName: string;
  public readonly statusCode?: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ShippingProviderErrorCode,
    providerName: string,
    statusCode?: number,
    details?: Record<string, unknown>,
  ) {
    super(`[${providerName}] ${code}: ${message}`);
    this.name = 'ShippingProviderError';
    this.code = code;
    this.providerName = providerName;
    this.statusCode = statusCode;
    this.details = details;
  }
}
