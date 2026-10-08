import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HttpStatus,
  InternalServerErrorException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { validateEnvironment } from '../src/common/config/validate-env.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { HealthController } from '../src/health/health.controller.js';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy.js';
import { UserRole, UserStatus } from '@vishkaraa/types';

describe('PHASE 18 — PRODUCTION HARDENING SPECIFICATION', () => {
  // ===========================================================================
  // 1. ENVIRONMENT / CONFIGURATION HARDENING
  // ===========================================================================
  describe('1. Environment & Configuration Security', () => {
    const baseValidProdEnv = {
      NODE_ENV: 'production',
      API_PORT: 3001,
      API_URL: 'https://api.vishkaraa.com',
      DATABASE_URL: 'postgresql://app_user:StrongPassword98765@db-prod.internal:5432/vishkaraa_prod',
      JWT_SECRET: 'prod-high-entropy-jwt-secret-key-that-is-at-least-64-characters-long-for-production-compliance-now',
      JWT_REFRESH_SECRET: 'prod-high-entropy-jwt-refresh-secret-key-that-is-at-least-64-characters-long-for-production-compliance-now',
      CORS_ORIGINS: 'https://vishkaraa.com',
      COOKIE_SECRET: 'production-cookie-signing-secret-key-32-chars',
      PAYMENT_PROVIDER: 'RAZORPAY',
      RAZORPAY_KEY_ID: 'rzp_live_1234567890',
      RAZORPAY_KEY_SECRET: 'rzp_live_secret_9876543210',
      RAZORPAY_WEBHOOK_SECRET: 'rzp_live_webhook_secret_12345',
    };

    it('validates a complete and hardened production configuration successfully', () => {
      const validated = validateEnvironment(baseValidProdEnv);
      expect(validated.NODE_ENV).toBe('production');
      expect(validated.DATABASE_URL).toBe(baseValidProdEnv.DATABASE_URL);
    });

    it('rejects production environment if PAYMENT_PROVIDER is missing or MOCK', () => {
      const prodWithMock = {
        ...baseValidProdEnv,
        PAYMENT_PROVIDER: 'MOCK',
      };
      expect(() => validateEnvironment(prodWithMock)).toThrowError(/MockPaymentProvider is strictly forbidden in production/);

      const prodWithoutProvider = { ...baseValidProdEnv };
      delete (prodWithoutProvider as any).PAYMENT_PROVIDER;
      expect(() => validateEnvironment(prodWithoutProvider)).toThrowError(/PAYMENT_PROVIDER environment variable must be explicitly set/);
    });

    it('rejects production environment if Razorpay credentials are incomplete', () => {
      const prodMissingWebhookSecret = {
        ...baseValidProdEnv,
        RAZORPAY_WEBHOOK_SECRET: '',
      };
      expect(() => validateEnvironment(prodMissingWebhookSecret)).toThrowError(/Razorpay configuration incomplete in production: missing required environment variable\(s\): RAZORPAY_WEBHOOK_SECRET/);
    });

    it('rejects production environment if COOKIE_SECRET is missing or weak', () => {
      const prodShortCookie = {
        ...baseValidProdEnv,
        COOKIE_SECRET: 'short',
      };
      expect(() => validateEnvironment(prodShortCookie)).toThrowError(/COOKIE_SECRET must be at least 32 characters/);

      const prodDevCookie = {
        ...baseValidProdEnv,
        COOKIE_SECRET: 'dev-only-insecure-cookie-secret-that-is-long-enough-32-chars',
      };
      expect(() => validateEnvironment(prodDevCookie)).toThrowError(/cannot use dev placeholder values in production/);
    });

    it('rejects production environment if DATABASE_URL is not PostgreSQL', () => {
      const prodInvalidDb = {
        ...baseValidProdEnv,
        DATABASE_URL: 'mysql://root:root@localhost:3306/db',
      };
      expect(() => validateEnvironment(prodInvalidDb)).toThrowError(/DATABASE_URL must be a valid PostgreSQL connection URL/);
    });
  });

  // ===========================================================================
  // 2. HTTP SECURITY & ERROR RESPONSE SANITIZATION
  // ===========================================================================
  describe('2. HTTP Security & Error Sanitization (AllExceptionsFilter)', () => {
    let filter: AllExceptionsFilter;
    let mockResponse: any;
    let mockRequest: any;
    let mockHost: ArgumentsHost;
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      filter = new AllExceptionsFilter();
      originalNodeEnv = process.env['NODE_ENV'];

      mockResponse = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
      };

      mockRequest = {
        url: '/api/v1/checkout',
        method: 'POST',
        headers: {},
      };

      mockHost = {
        switchToHttp: () => ({
          getResponse: () => mockResponse,
          getRequest: () => mockRequest,
        }),
      } as unknown as ArgumentsHost;
    });

    it('sanitizes 500 InternalServerError in production without leaking internal details', () => {
      process.env['NODE_ENV'] = 'production';

      const sensitiveInternalError = new InternalServerErrorException(
        'PrismaClientKnownRequestError: Unique constraint failed on the fields: (email) at postgresql://postgres:secret@10.0.0.1:5432',
      );

      filter.catch(sensitiveInternalError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      const payload = mockResponse.json.mock.calls[0][0];
      expect(payload.success).toBe(false);
      expect(payload.error.message).toBe('An internal error occurred. Please contact support with the correlation ID.');
      expect(payload.error.message).not.toContain('postgres');
      expect(payload.error.message).not.toContain('secret');
      expect(payload.error.message).not.toContain('10.0.0.1');

      process.env['NODE_ENV'] = originalNodeEnv;
    });

    it('sanitizes unhandled Error in production without leaking database internals', () => {
      process.env['NODE_ENV'] = 'production';

      const unhandledError = new Error('FATAL: relation "users" does not exist at /var/app/dist/main.js:42');
      filter.catch(unhandledError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      const payload = mockResponse.json.mock.calls[0][0];
      expect(payload.success).toBe(false);
      expect(payload.error.code).toBe('INTERNAL_ERROR');
      expect(payload.error.message).toBe('An internal error occurred. Please contact support with the correlation ID.');
      expect(payload.error.message).not.toContain('relation "users"');
      expect(payload.error.message).not.toContain('/var/app/dist');

      process.env['NODE_ENV'] = originalNodeEnv;
    });

    it('preserves clean domain messages on 4xx client errors (e.g. 400 validation, 403 forbidden)', () => {
      const forbiddenError = new ForbiddenException('Access denied: You are not authorized to view other user profiles');
      filter.catch(forbiddenError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      const payload = mockResponse.json.mock.calls[0][0];
      expect(payload.success).toBe(false);
      expect(payload.error.message).toBe('Access denied: You are not authorized to view other user profiles');
    });

    it('generates or preserves X-Correlation-ID for every response', () => {
      mockRequest.headers['x-correlation-id'] = 'trace-uuid-12345';
      filter.catch(new BadRequestException('Invalid input'), mockHost);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'trace-uuid-12345');
    });
  });

  // ===========================================================================
  // 3. HEALTH, LIVENESS, AND READINESS PROBES
  // ===========================================================================
  describe('3. Production Health, Liveness, and Readiness', () => {
    let healthController: HealthController;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        $queryRaw: vi.fn(),
      };
      healthController = new HealthController(mockPrisma);
    });

    it('liveness endpoint returns HTTP 200 ok without database call', () => {
      const result = healthController.getLiveness();
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('ok');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('readiness endpoint returns HTTP 200 ok when database responds', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      const result = await healthController.getReadiness();
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('ok');
      expect(result.data.database).toBe('ok');
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it('readiness endpoint throws 503 ServiceUnavailableException when database fails', async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
      await expect(healthController.getReadiness()).rejects.toThrow(ServiceUnavailableException);
    });

    it('comprehensive health check throws 503 when database is degraded', async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('Database timeout'));
      await expect(healthController.check()).rejects.toThrow(ServiceUnavailableException);
    });

    it('comprehensive health check returns 200 when database is healthy', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      const res = await healthController.check();
      expect(res.success).toBe(true);
      expect(res.data.status).toBe('ok');
      expect(res.data.services.database).toBe('ok');
    });
  });

  // ===========================================================================
  // 4. AUTHENTICATION & SESSION LIFECYCLE
  // ===========================================================================
  describe('4. Authentication & Session Lifecycle Security', () => {
    let jwtStrategy: JwtStrategy;
    let mockConfigService: any;
    let mockUsersService: any;

    beforeEach(() => {
      mockConfigService = {
        get: vi.fn((key: string) => {
          if (key === 'JWT_SECRET') return 'test-jwt-secret-key-at-least-32-chars-long';
          return null;
        }),
      };

      mockUsersService = {
        findById: vi.fn(),
      };

      jwtStrategy = new JwtStrategy(mockConfigService, mockUsersService);
    });

    it('immediately rejects authenticated request if user status is SUSPENDED', async () => {
      mockUsersService.findById.mockResolvedValueOnce({
        id: 'suspended-user-uuid',
        email: 'suspended@vishkaraa.local',
        passwordHash: 'hashed',
        role: UserRole.USER,
        status: UserStatus.SUSPENDED,
      });

      await expect(
        jwtStrategy.validate({ sub: 'suspended-user-uuid', email: 'suspended@vishkaraa.local', role: UserRole.USER }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('immediately rejects authenticated request if user has been deleted or does not exist', async () => {
      mockUsersService.findById.mockResolvedValueOnce(null);

      await expect(
        jwtStrategy.validate({ sub: 'deleted-user-uuid', email: 'deleted@vishkaraa.local', role: UserRole.USER }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('strips passwordHash before returning validated user context', async () => {
      mockUsersService.findById.mockResolvedValueOnce({
        id: 'active-user-uuid',
        email: 'active@vishkaraa.local',
        passwordHash: '$2b$12$SuperSecretHashValue',
        firstName: 'John',
        lastName: 'Doe',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
      });

      const user = await jwtStrategy.validate({
        sub: 'active-user-uuid',
        email: 'active@vishkaraa.local',
        role: UserRole.USER,
      });

      expect(user).toHaveProperty('id', 'active-user-uuid');
      expect((user as any).passwordHash).toBeUndefined();
    });
  });
});
