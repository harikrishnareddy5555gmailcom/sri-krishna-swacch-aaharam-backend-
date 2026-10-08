/**
 * Payment Provider Configuration & Resolution
 *
 * P0-1: Explicit environment/provider behavior.
 * - In production: Mock provider is strictly rejected.
 *   PAYMENT_PROVIDER must be explicitly configured to 'RAZORPAY'.
 *   All required Razorpay credentials must be present.
 * - In development/test: Mock provider is allowed (defaults to MOCK if not specified).
 *   If explicitly set to RAZORPAY, credentials must still be present and valid.
 * - ZERO possibility of silently falling back to Mock in production.
 */

export interface PaymentProviderEnv {
  NODE_ENV?: string;
  PAYMENT_PROVIDER?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
}

export type SupportedPaymentProviderName = 'MOCK' | 'RAZORPAY';

/**
 * Resolves and validates the active payment provider according to environment rules.
 * Throws explicit errors on invalid or insecure configurations.
 */
export function resolvePaymentProviderConfig(
  env: PaymentProviderEnv = process.env,
): SupportedPaymentProviderName {
  const nodeEnv = (env.NODE_ENV || 'development').toLowerCase();
  const isProduction = nodeEnv === 'production';
  const rawProvider = env.PAYMENT_PROVIDER?.trim().toUpperCase();

  // In production, PAYMENT_PROVIDER MUST be explicitly configured
  if (isProduction) {
    if (!rawProvider) {
      throw new Error(
        'Production configuration error: PAYMENT_PROVIDER environment variable must be explicitly set (e.g., PAYMENT_PROVIDER=RAZORPAY).',
      );
    }
    if (rawProvider === 'MOCK') {
      throw new Error(
        'FATAL: MockPaymentProvider is strictly forbidden in production environment. Configure PAYMENT_PROVIDER=RAZORPAY with valid credentials.',
      );
    }
  }

  // Non-production default if unconfigured: MOCK
  const selectedProvider: string = rawProvider || 'MOCK';

  if (selectedProvider === 'MOCK') {
    if (isProduction) {
      throw new Error('Mock payment provider is not permitted in production environment.');
    }
    return 'MOCK';
  }

  if (selectedProvider === 'RAZORPAY') {
    const missing: string[] = [];
    if (!env.RAZORPAY_KEY_ID?.trim()) missing.push('RAZORPAY_KEY_ID');
    if (!env.RAZORPAY_KEY_SECRET?.trim()) missing.push('RAZORPAY_KEY_SECRET');
    if (!env.RAZORPAY_WEBHOOK_SECRET?.trim()) missing.push('RAZORPAY_WEBHOOK_SECRET');

    if (missing.length > 0) {
      throw new Error(
        `Razorpay configuration incomplete: missing required environment variable(s): ${missing.join(', ')}.`,
      );
    }
    return 'RAZORPAY';
  }

  throw new Error(
    `Invalid PAYMENT_PROVIDER: "${env.PAYMENT_PROVIDER}". Supported providers: MOCK, RAZORPAY.`,
  );
}
