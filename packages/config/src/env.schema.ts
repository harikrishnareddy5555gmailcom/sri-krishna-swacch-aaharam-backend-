import { z } from 'zod';

/**
 * Backend environment variable schema.
 * Validates all required environment variables at startup.
 * If any required variable is missing, the application will fail fast.
 */
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_URL: z.string().url(),
  API_VERSION: z.string().default('v1'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Security
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // Rate limiting
  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // Audit
  AUDIT_LOG_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  // Payment — Razorpay (optional at schema level; required at provider boot if Razorpay is active)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Storage — Cloudflare R2 / S3
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),

  // Shipping Webhook Secrets (optional at schema level; required per active provider)
  SHIPPING_WEBHOOK_SECRET_MOCK: z.string().optional(),
  SHIPPING_WEBHOOK_SECRET_SHIPROCKET: z.string().optional(),
  SHIPPING_WEBHOOK_SECRET_DELHIVERY: z.string().optional(),

  // Cookie security
  COOKIE_SECRET: z.string().optional(),
});

/**
 * Frontend environment variable schema.
 * Only includes VITE_* variables that are safe to expose publicly.
 *
 * SECURITY REMINDER: Never put secrets in VITE_* variables.
 * These are bundled into the JavaScript and are publicly readable.
 */
export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url().default('http://localhost:3001/api/v1'),
  VITE_RAZORPAY_KEY_ID: z.string().optional(),
});

export type BackendEnv = z.infer<typeof backendEnvSchema>;
export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
