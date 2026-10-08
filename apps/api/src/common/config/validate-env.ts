import { backendEnvSchema, type BackendEnv } from '@vishkaraa/config';
import type { ZodIssue } from 'zod';

/**
 * Validates backend environment variables at application startup.
 * Fails fast if any required variable is missing or fails security rules.
 *
 * SENSITIVITY SAFETY:
 * Error messages identify the key and reason, but NEVER echo actual secret values.
 */
export function validateEnvironment(
  env: Record<string, unknown> = process.env,
): BackendEnv {
  const result = backendEnvSchema.safeParse(env);

  if (!result.success) {
    const errorMessages = result.error.issues.map((issue: ZodIssue) => {
      const field = issue.path.join('.');
      return ` - ${field}: ${issue.message}`;
    });

    const errorSummary = [
      '🚨 FATAL: Backend environment configuration validation failed at startup:',
      ...errorMessages,
      'Startup aborted. Please correct the environment variables before restarting.',
    ].join('\n');

    throw new Error(errorSummary);
  }

  const validated = result.data;

  // Security invariant: CORS wildcard '*' forbidden with credentials
  const corsOrigins = validated.CORS_ORIGINS.split(',').map((s: string) => s.trim());
  if (corsOrigins.includes('*')) {
    throw new Error(
      '🚨 FATAL: Security violation in CORS_ORIGINS: Wildcard "*" is prohibited when credentials are enabled.',
    );
  }

  // Security invariant: In production, secrets must be high-entropy and not dev placeholders
  if (validated.NODE_ENV === 'production') {
    if (
      validated.JWT_SECRET.includes('dev-only-insecure') ||
      validated.JWT_SECRET.length < 64
    ) {
      throw new Error(
        '🚨 FATAL: Production security violation: JWT_SECRET must be at least 64 characters and cannot use dev placeholder values.',
      );
    }
    if (
      validated.JWT_REFRESH_SECRET.includes('dev-only-insecure') ||
      validated.JWT_REFRESH_SECRET.length < 64
    ) {
      throw new Error(
        '🚨 FATAL: Production security violation: JWT_REFRESH_SECRET must be at least 64 characters and cannot use dev placeholder values.',
      );
    }
    if (
      !validated.COOKIE_SECRET ||
      validated.COOKIE_SECRET.includes('dev-only-insecure') ||
      validated.COOKIE_SECRET.length < 32
    ) {
      throw new Error(
        '🚨 FATAL: Production security violation: COOKIE_SECRET must be at least 32 characters and cannot use dev placeholder values in production.',
      );
    }
    if (
      !validated.DATABASE_URL.startsWith('postgresql://') &&
      !validated.DATABASE_URL.startsWith('postgres://')
    ) {
      throw new Error(
        '🚨 FATAL: Production security violation: DATABASE_URL must be a valid PostgreSQL connection URL.',
      );
    }
    const paymentProvider = ((env['PAYMENT_PROVIDER'] as string) || '').trim().toUpperCase();
    if (!paymentProvider) {
      throw new Error(
        '🚨 FATAL: Production configuration error: PAYMENT_PROVIDER environment variable must be explicitly set (e.g., PAYMENT_PROVIDER=RAZORPAY).',
      );
    }
    if (paymentProvider === 'MOCK') {
      throw new Error(
        '🚨 FATAL: MockPaymentProvider is strictly forbidden in production environment. Configure PAYMENT_PROVIDER=RAZORPAY with valid credentials.',
      );
    }
    if (paymentProvider === 'RAZORPAY') {
      const missing: string[] = [];
      if (!(env['RAZORPAY_KEY_ID'] as string)?.trim()) missing.push('RAZORPAY_KEY_ID');
      if (!(env['RAZORPAY_KEY_SECRET'] as string)?.trim()) missing.push('RAZORPAY_KEY_SECRET');
      if (!(env['RAZORPAY_WEBHOOK_SECRET'] as string)?.trim()) missing.push('RAZORPAY_WEBHOOK_SECRET');
      if (missing.length > 0) {
        throw new Error(
          `🚨 FATAL: Razorpay configuration incomplete in production: missing required environment variable(s): ${missing.join(', ')}.`,
        );
      }
    }
  }

  return validated;
}
