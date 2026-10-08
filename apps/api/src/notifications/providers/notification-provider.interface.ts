import {
  type DeliveryStatus,
  type NormalizedDeliveryResult,
  type EmailInput,
  type SmsInput,
  type IEmailProvider,
  type ISmsProvider,
} from '@vishkaraa/types';

export {
  type DeliveryStatus,
  type NormalizedDeliveryResult,
  type EmailInput,
  type SmsInput,
  type IEmailProvider,
  type ISmsProvider,
};

/**
 * Sanitizes provider error messages to prevent leakage of credentials,
 * auth tokens, secret keys, or raw request headers.
 */
export function sanitizeProviderErrorMessage(rawMessage: string): string {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return 'Unknown provider error';
  }

  let sanitized = rawMessage
    // Strip Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    // Strip apiKey / secretKey / token query or header params
    .replace(/(api[_-]?key|secret[_-]?key|auth[_-]?token|password|credentials?)\s*[:=]\s*['"]?[^\s,'"&]+['"]?/gi, '$1=[REDACTED]')
    // Strip authorization header lines
    .replace(/authorization\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]')
    // Strip potential JWTs (3 dot-separated base64 chunks)
    .replace(/ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');

  // Bound length to avoid huge dumps
  if (sanitized.length > 500) {
    sanitized = sanitized.slice(0, 500) + '... [truncated]';
  }

  return sanitized.trim();
}

/**
 * Normalized provider error class.
 * Captures error classification, retryability, and sanitized message.
 */
export class NormalizedProviderError extends Error {
  public readonly providerName: string;
  public readonly errorCode: string;
  public readonly isRetryable: boolean;
  public readonly sanitizedErrorMessage: string;

  constructor(params: {
    providerName: string;
    errorCode: string;
    message: string;
    isRetryable: boolean;
  }) {
    const sanitized = sanitizeProviderErrorMessage(params.message);
    super(`[${params.providerName}] ${params.errorCode}: ${sanitized}`);
    this.name = 'NormalizedProviderError';
    this.providerName = params.providerName;
    this.errorCode = params.errorCode;
    this.isRetryable = params.isRetryable;
    this.sanitizedErrorMessage = sanitized;
    Object.setPrototypeOf(this, NormalizedProviderError.prototype);
  }
}
