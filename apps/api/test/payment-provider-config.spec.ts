/**
 * Payment Provider Configuration Tests (P0-1)
 *
 * Verifies:
 * 1. development + MOCK works
 * 2. test + MOCK works
 * 3. production + MOCK fails
 * 4. production + RAZORPAY + missing key fails
 * 5. production + RAZORPAY + complete config selects Razorpay
 * 6. malformed/partial Razorpay configuration fails
 */

import { describe, it, expect } from 'vitest';
import { resolvePaymentProviderConfig } from '../src/payment/payment-provider.config.js';

describe('Payment Provider Configuration & Resolution (P0-1)', () => {
  it('1. development + MOCK works (explicit and default)', () => {
    // Explicit MOCK in development
    const result1 = resolvePaymentProviderConfig({
      NODE_ENV: 'development',
      PAYMENT_PROVIDER: 'MOCK',
    });
    expect(result1).toBe('MOCK');

    // Default to MOCK when unset in development
    const result2 = resolvePaymentProviderConfig({
      NODE_ENV: 'development',
    });
    expect(result2).toBe('MOCK');
  });

  it('2. test + MOCK works (explicit and default)', () => {
    // Explicit MOCK in test
    const result1 = resolvePaymentProviderConfig({
      NODE_ENV: 'test',
      PAYMENT_PROVIDER: 'MOCK',
    });
    expect(result1).toBe('MOCK');

    // Default to MOCK when unset in test
    const result2 = resolvePaymentProviderConfig({
      NODE_ENV: 'test',
    });
    expect(result2).toBe('MOCK');
  });

  it('3. production + MOCK fails (strictly forbidden)', () => {
    // Explicit MOCK in production must be rejected
    expect(() =>
      resolvePaymentProviderConfig({
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'MOCK',
      }),
    ).toThrow(/MockPaymentProvider is strictly forbidden in production/i);

    // Unset PAYMENT_PROVIDER in production must also fail
    expect(() =>
      resolvePaymentProviderConfig({
        NODE_ENV: 'production',
      }),
    ).toThrow(/PAYMENT_PROVIDER environment variable must be explicitly set/i);
  });

  it('4. production + RAZORPAY + missing key fails', () => {
    // Missing key secret and webhook secret
    expect(() =>
      resolvePaymentProviderConfig({
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'RAZORPAY',
        RAZORPAY_KEY_ID: 'rzp_live_12345',
      }),
    ).toThrow(/Razorpay configuration incomplete/i);

    // Missing key ID
    expect(() =>
      resolvePaymentProviderConfig({
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'RAZORPAY',
        RAZORPAY_KEY_SECRET: 'secret_live_12345',
        RAZORPAY_WEBHOOK_SECRET: 'whsec_live_12345',
      }),
    ).toThrow(/RAZORPAY_KEY_ID/);
  });

  it('5. production + RAZORPAY + complete config selects Razorpay', () => {
    const result = resolvePaymentProviderConfig({
      NODE_ENV: 'production',
      PAYMENT_PROVIDER: 'RAZORPAY',
      RAZORPAY_KEY_ID: 'rzp_live_12345',
      RAZORPAY_KEY_SECRET: 'secret_live_12345',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_live_12345',
    });
    expect(result).toBe('RAZORPAY');
  });

  it('6. malformed/partial Razorpay configuration fails in any environment', () => {
    // Missing webhook secret in development when explicitly requesting RAZORPAY
    expect(() =>
      resolvePaymentProviderConfig({
        NODE_ENV: 'development',
        PAYMENT_PROVIDER: 'RAZORPAY',
        RAZORPAY_KEY_ID: 'rzp_test_12345',
        RAZORPAY_KEY_SECRET: 'secret_test_12345',
        // missing RAZORPAY_WEBHOOK_SECRET
      }),
    ).toThrow(/RAZORPAY_WEBHOOK_SECRET/);

    // Completely unknown/malformed provider name
    expect(() =>
      resolvePaymentProviderConfig({
        NODE_ENV: 'development',
        PAYMENT_PROVIDER: 'STRIPE_UNSUPPORTED',
      }),
    ).toThrow(/Invalid PAYMENT_PROVIDER/i);
  });
});
