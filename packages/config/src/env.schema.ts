import { z } from 'zod';

/**
 * Backend environment variable schema.
 * Validates environment variables at startup with safe production fallbacks.
 */
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_URL: z.string().default('http://localhost:3001'),
  API_VERSION: z.string().default('v1'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // JWT
  JWT_SECRET: z
    .string()
    .default('sri-krishna-swacch-aaharam-production-jwt-access-key-secure-64-bytes-entropy-9988'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z
    .string()
    .default('sri-krishna-swacch-aaharam-production-jwt-refresh-key-secure-64-bytes-entropy-7766'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Security
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  CORS_ORIGINS: z.string().default('*'),

  // Rate limiting
  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // Audit
  AUDIT_LOG_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  // Payment - Razorpay
  PAYMENT_PROVIDER: z.string().default('MOCK'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Storage
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),

  // Shipping
  SHIPPING_WEBHOOK_SECRET_MOCK: z.string().optional(),
  SHIPPING_WEBHOOK_SECRET_SHIPROCKET: z.string().optional(),
  SHIPPING_WEBHOOK_SECRET_DELHIVERY: z.string().optional(),

  // Cookie security
  COOKIE_SECRET: z
    .string()
    .default('sri-krishna-swacch-aaharam-cookie-session-secret-key-32-chars-long'),
});

export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url().default('http://localhost:3001/api/v1'),
  VITE_RAZORPAY_KEY_ID: z.string().optional(),
});

export type BackendEnv = z.infer<typeof backendEnvSchema>;
export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
