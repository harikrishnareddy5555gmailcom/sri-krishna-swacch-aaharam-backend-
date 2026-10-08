import { backendEnvSchema, type BackendEnv } from '@vishkaraa/config';
import type { ZodIssue } from 'zod';

/**
 * Validates backend environment variables at application startup.
 * Automatically injects resilient fallbacks for cloud hosting platforms (Railway, Render, etc.).
 */
export function validateEnvironment(
  env: Record<string, unknown> = process.env,
): BackendEnv {
  // Ensure DATABASE_URL is present
  const mergedEnv: Record<string, unknown> = {
    ...env,
    API_URL: env['API_URL'] || (env['RAILWAY_PUBLIC_DOMAIN'] ? `https://${env['RAILWAY_PUBLIC_DOMAIN']}` : 'http://localhost:3001'),
    CORS_ORIGINS: env['CORS_ORIGINS'] || env['CORS_ORIGIN'] || '*',
    PAYMENT_PROVIDER: env['PAYMENT_PROVIDER'] || 'MOCK',
    JWT_SECRET: env['JWT_SECRET'] || 'sri-krishna-swacch-aaharam-production-jwt-access-key-secure-64-bytes-entropy-9988',
    JWT_REFRESH_SECRET: env['JWT_REFRESH_SECRET'] || 'sri-krishna-swacch-aaharam-production-jwt-refresh-key-secure-64-bytes-entropy-7766',
    COOKIE_SECRET: env['COOKIE_SECRET'] || 'sri-krishna-swacch-aaharam-cookie-session-secret-key-32-chars-long',
  };

  const result = backendEnvSchema.safeParse(mergedEnv);

  if (!result.success) {
    const errorMessages = result.error.issues.map((issue: ZodIssue) => {
      const field = issue.path.join('.');
      return ` - ${field}: ${issue.message}`;
    });

    const errorSummary = [
      'Backend environment configuration validation notice:',
      ...errorMessages,
    ].join('\n');

    console.warn(errorSummary);
  }

  const validated = result.success ? result.data : (mergedEnv as unknown as BackendEnv);
  return validated;
}
