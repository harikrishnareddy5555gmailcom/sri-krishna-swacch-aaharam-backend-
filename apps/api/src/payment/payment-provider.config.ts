/**
 * Payment Provider Configuration & Resolution
 *
 * Supports both MOCK (for testing/demo/staging) and RAZORPAY (for live payments).
 * Resilient boot: Never crashes the application if payment credentials are not yet configured.
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
 * Automatically defaults to MOCK mode if RAZORPAY credentials are not provided.
 */
export function resolvePaymentProviderConfig(
  env: PaymentProviderEnv = process.env,
): SupportedPaymentProviderName {
  const rawProvider = (env.PAYMENT_PROVIDER || 'MOCK').trim().toUpperCase();

  if (rawProvider === 'RAZORPAY') {
    const hasKeys =
      Boolean(env.RAZORPAY_KEY_ID?.trim()) &&
      Boolean(env.RAZORPAY_KEY_SECRET?.trim());

    if (!hasKeys) {
      console.warn(
        '[PaymentConfig] RAZORPAY requested but credentials missing. Falling back to MOCK provider for safe boot.',
      );
      return 'MOCK';
    }
    return 'RAZORPAY';
  }

  // Default to MOCK
  return 'MOCK';
}
