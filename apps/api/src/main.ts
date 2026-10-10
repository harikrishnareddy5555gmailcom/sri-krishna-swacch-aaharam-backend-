/**
 * Vishkaraa API — Application Bootstrap & Hardened Security Baseline
 *
 * Initializes the NestJS application with:
 * - Security headers (Helmet with CSP, HSTS, noSniff, frameguard)
 * - Cookie Parser (for secure httpOnly refresh tokens)
 * - Strict CORS configuration (explicit origin allowlist, credentials protection)
 * - Global input validation pipe (whitelist, forbidNonWhitelisted)
 * - Global exception filter (sanitized error output, correlation IDs)
 * - API versioning (/api/v1/...)
 * - Swagger documentation (development only)
 * - Graceful shutdown hooks
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { validateEnvironment } from './common/config/validate-env.js';

// Pre-load environment files from both local directory and monorepo root
// Suppress benign Node version support warning from AWS SDK v3 in production container
process.on('warning', (warning) => {
  if (warning.name === 'NodeVersionSupportWarning') return;
  console.warn('[' + warning.name + '] ' + warning.message);
});

// Pre-load local environment files in development/test
if (process.env['NODE_ENV'] !== 'production') {
  dotenv.config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
  dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });
}
async function bootstrap(): Promise<void> {
  // Validate configuration fail-fast before spinning up modules or listeners
  validateEnvironment();

  const app = await NestFactory.create(AppModule, {
    // Disable verbose logging in production
    logger:
      process.env['NODE_ENV'] === 'production'
        ? ['error', 'warn']
        : ['log', 'error', 'warn', 'debug', 'verbose'],
    // IMPORTANT: disable NestJS built-in body parser so we can register
    // express.raw() for the webhook route BEFORE the global JSON parser.
    bodyParser: false,
  });

  // ─── Body Parsers ───────────────────────────────────────────────────────────
  // SECURITY: The Razorpay webhook route MUST receive the raw Buffer body so that
  // HMAC-SHA256 signature verification operates on the exact bytes Razorpay signed.
  // Any JSON.parse → JSON.stringify round-trip would invalidate the signature.
  //
  // We register express.raw() for the exact webhook path BEFORE express.json(),
  // so only that route skips JSON deserialization.
  app.use(
    '/api/v1/webhooks/razorpay',
    express.raw({ type: 'application/json', limit: '1mb' }),
  );
  app.use(
    '/api/v1/webhooks/shipping',
    express.raw({ type: 'application/json', limit: '1mb' }),
  );

  // All other routes use standard JSON body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ─── Security Headers (Helmet) ──────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
          frameSrc: ["'self'", 'https://api.razorpay.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: [
            "'self'",
            'https://api.razorpay.com',
            'https://lumberjack.razorpay.com',
            ...(process.env['CORS_ORIGINS']?.split(',').map((s) => s.trim()) || [
              'http://localhost:5173',
            ]),
          ],
        },
      },
      crossOriginEmbedderPolicy: false,
      xContentTypeOptions: true,
      referrerPolicy: { policy: 'same-origin' },
      frameguard: { action: 'deny' },
      hsts:
        process.env['NODE_ENV'] === 'production'
          ? {
              maxAge: 31536000,
              includeSubDomains: true,
              preload: true,
            }
          : false,
    }),
  );

  // ─── Cookie Parser ─────────────────────────────────────────────────────────
  app.use(cookieParser(process.env['COOKIE_SECRET']));

  // CORS
  const rawOrigins = (process.env["CORS_ORIGINS"] || process.env["CORS_ORIGIN"] || "*").split(",").map((o) => o.trim());
  const isWildcard = rawOrigins.includes("*");

  app.enableCors({
    origin: isWildcard ? true : rawOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Cache-Control",
      "cache-control",
      "Pragma",
      "pragma",
      "X-Requested-With",
      "x-requested-with",
      "Origin",
      "Content-Type",
      "Authorization",
      "X-Correlation-ID",
      "Accept",
      "x-guest-cart-token",
      "X-Guest-Cart-Token",
    ],
    exposedHeaders: ["X-Correlation-ID", "x-guest-cart-token", "X-Guest-Cart-Token"],
  });

  // ─── Graceful Shutdown Hooks (registered before listener starts) ───────────
  app.enableShutdownHooks();

  // ─── API Versioning ─────────────────────────────────────────────────────────
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // ─── Global Error Sanitization Filter ───────────────────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter());

  // ─── Global Validation Pipe ─────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ─── Swagger (Development Only) ─────────────────────────────────────────────
  if (process.env['NODE_ENV'] !== 'production') {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const config = new DocumentBuilder()
      .setTitle('Vishkaraa API')
      .setDescription('Product & Order Management Platform API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // ─── Start Server ────────────────────────────────────────────────────────────
  const port = parseInt(process.env['PORT'] ?? process.env['API_PORT'] ?? '3001', 10);
  await app.listen(port, '0.0.0.0');

  console.log(`\n✅ Vishkaraa API running on: http://localhost:${port}/api/v1`);
  if (process.env['NODE_ENV'] !== 'production') {
    console.log(`📖 Swagger docs: http://localhost:${port}/api/docs`);
  }
}

await bootstrap();


