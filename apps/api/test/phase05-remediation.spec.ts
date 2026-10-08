import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { UserRole, Permissions } from '@vishkaraa/types';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_REGISTRY,
  isPermissionAssignableToAdmin,
} from '@vishkaraa/shared';
import { sanitizeAuditPayload, isSensitiveKey } from '../src/audit/audit.service.js';
import { validateEnvironment } from '../src/common/config/validate-env.js';
import { EntityOwnershipService } from '../src/common/services/entity-ownership.service.js';
import { Prisma } from '@prisma/client';

describe('Phase 05 Remediation & Security Gate Tests', () => {
  // ─── 1. Fresh Migration Baseline Verification ─────────────────────────────
  describe('1. Database Migration Baseline', () => {
    it('contains baseline migration constructing all tables in dependency order', () => {
      const migrationPath = path.resolve(
        __dirname,
        '../prisma/migrations/20260928000000_init_baseline/migration.sql',
      );
      expect(fs.existsSync(migrationPath)).toBe(true);

      const sql = fs.readFileSync(migrationPath, 'utf8');

      // Verify all required core tables are created
      const requiredTables = [
        '"users"',
        '"roles"',
        '"permissions"',
        '"role_permissions"',
        '"user_permissions"',
        '"features"',
        '"audit_logs"',
        '"refresh_tokens"',
        '"categories"',
        '"products"',
        '"product_variants"',
        '"product_media"',
        '"carts"',
        '"cart_items"',
        '"orders"',
        '"order_items"',
        '"returns"',
        '"refunds"',
      ];

      for (const table of requiredTables) {
        expect(sql).toContain(`CREATE TABLE ${table}`);
      }

      // Verify partial unique index for single active cart per user
      expect(sql).toContain('carts_user_id_active_unique');
      expect(sql).toContain('WHERE "status" = \'ACTIVE\' AND "userId" IS NOT NULL');
    });
  });

  // ─── 2. ADMIN Catalog Permissions & 3. Ceiling & 4. USER Boundary ──────────
  describe('2-4. Catalog Permission Matrix & Super Admin Privilege Ceiling', () => {
    it('grants operational catalog permissions to ADMIN role baseline', () => {
      const adminPerms = DEFAULT_ROLE_PERMISSIONS[UserRole.ADMIN];

      // Products
      expect(adminPerms).toContain(Permissions.PRODUCTS_VIEW);
      expect(adminPerms).toContain(Permissions.PRODUCTS_CREATE);
      expect(adminPerms).toContain(Permissions.PRODUCTS_UPDATE);
      expect(adminPerms).toContain(Permissions.PRODUCTS_DELETE);
      expect(adminPerms).toContain(Permissions.PRODUCTS_PUBLISH);

      // Variants
      expect(adminPerms).toContain(Permissions.PRODUCT_VARIANTS_VIEW);
      expect(adminPerms).toContain(Permissions.PRODUCT_VARIANTS_CREATE);
      expect(adminPerms).toContain(Permissions.PRODUCT_VARIANTS_UPDATE);
      expect(adminPerms).toContain(Permissions.PRODUCT_VARIANTS_DELETE);

      // Media
      expect(adminPerms).toContain(Permissions.PRODUCT_MEDIA_VIEW);
      expect(adminPerms).toContain(Permissions.PRODUCT_MEDIA_MANAGE);

      // Categories
      expect(adminPerms).toContain(Permissions.CATEGORIES_VIEW);
      expect(adminPerms).toContain(Permissions.CATEGORIES_CREATE);
      expect(adminPerms).toContain(Permissions.CATEGORIES_UPDATE);
      expect(adminPerms).toContain(Permissions.CATEGORIES_DELETE);
    });

    it('strictly preserves the Super Admin privilege ceiling (Admins cannot manage platform governance)', () => {
      const adminPerms = DEFAULT_ROLE_PERMISSIONS[UserRole.ADMIN];

      // Super Admin only governance permissions
      const superAdminOnly = [
        Permissions.ADMINS_MANAGE,
        Permissions.SETTINGS_MANAGE,
        Permissions.FEATURES_MANAGE,
        Permissions.PERMISSIONS_MANAGE,
        Permissions.ROLES_MANAGE,
      ];

      for (const perm of superAdminOnly) {
        expect(adminPerms).not.toContain(perm);
        expect(isPermissionAssignableToAdmin(perm)).toBe(false);
      }
    });

    it('ensures USER role possesses NO catalog mutation permissions', () => {
      const userPerms = DEFAULT_ROLE_PERMISSIONS[UserRole.USER];

      expect(userPerms).toContain(Permissions.PRODUCTS_VIEW);
      expect(userPerms).toContain(Permissions.CATEGORIES_VIEW);

      expect(userPerms).not.toContain(Permissions.PRODUCTS_CREATE);
      expect(userPerms).not.toContain(Permissions.PRODUCTS_UPDATE);
      expect(userPerms).not.toContain(Permissions.PRODUCTS_DELETE);
      expect(userPerms).not.toContain(Permissions.PRODUCT_VARIANTS_CREATE);
      expect(userPerms).not.toContain(Permissions.PRODUCT_MEDIA_MANAGE);
      expect(userPerms).not.toContain(Permissions.CATEGORIES_CREATE);
    });
  });

  // ─── 5-6. Entity Ownership Security ────────────────────────────────────────
  describe('5-6. Entity Ownership Security (EntityOwnershipService)', () => {
    let service: EntityOwnershipService;
    let mockPrisma: any;
    let mockPermissionsService: any;

    beforeEach(() => {
      mockPrisma = {
        cart: { findUnique: vi.fn() },
        order: { findUnique: vi.fn() },
        return: { findUnique: vi.fn() },
        refund: { findUnique: vi.fn() },
      };
      mockPermissionsService = {
        can: vi.fn(),
      };
      service = new EntityOwnershipService(mockPrisma, mockPermissionsService);
    });

    it('allows User A accessing own Cart, but denies User A accessing User B Cart', async () => {
      mockPrisma.cart.findUnique.mockResolvedValue({ userId: 'user-b' });

      // User A attempts to access User B's cart
      const userA = { id: 'user-a', role: UserRole.USER };
      const deniedResult = await service.isAuthorized(userA, 'CART', 'cart-123');
      expect(deniedResult.authorized).toBe(false);

      // User B accesses own cart
      const userB = { id: 'user-b', role: UserRole.USER };
      const allowedResult = await service.isAuthorized(userB, 'CART', 'cart-123');
      expect(allowedResult.authorized).toBe(true);
    });

    it('prevents ADMIN from automatically bypassing customer order ownership without explicit permission', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ userId: 'customer-1' });
      mockPermissionsService.can.mockResolvedValue(false);

      const admin = { id: 'admin-1', role: UserRole.ADMIN };

      // Admin without designated bypass permission
      const noBypassResult = await service.isAuthorized(admin, 'ORDER', 'order-99');
      expect(noBypassResult.authorized).toBe(false);

      // Admin with designated bypass permission (e.g. ORDERS.VIEW)
      mockPermissionsService.can.mockResolvedValue(true);
      const withBypassResult = await service.isAuthorized(admin, 'ORDER', 'order-99', ['ORDERS.VIEW']);
      expect(withBypassResult.authorized).toBe(true);
    });

    it('allows SUPER_ADMIN platform-wide access regardless of ownership', async () => {
      const superAdmin = { id: 'super-1', role: UserRole.SUPER_ADMIN };
      const result = await service.isAuthorized(superAdmin, 'ORDER', 'order-99');
      expect(result.authorized).toBe(true);
    });
  });

  // ─── 7. Audit Secret Redaction ─────────────────────────────────────────────
  describe('7. Audit Log Secret Redaction', () => {
    it('detects sensitive keys correctly', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('passwordHash')).toBe(true);
      expect(isSensitiveKey('jwtSecret')).toBe(true);
      expect(isSensitiveKey('refreshToken')).toBe(true);
      expect(isSensitiveKey('creditCardNumber')).toBe(true);
      expect(isSensitiveKey('cvv')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);
      expect(isSensitiveKey('name')).toBe(false);
      expect(isSensitiveKey('price')).toBe(false);
    });

    it('recursively sanitizes nested objects and arrays without leaking secret values', () => {
      const sensitivePayload = {
        userId: 'u-1',
        email: 'test@vishkaraa.com',
        credentials: 'api-secret-key-12345',
        profile: {
          passwordHash: '$2b$12$dummyhashvalue',
          salt: 'randomsalt',
        },
        items: [
          { sessionToken: 'jwt-access-token-123', type: 'access' },
          { refreshToken: 'refresh-token-456', type: 'refresh' },
        ],
        payment: {
          creditCard: '4111111111111111',
          cvv: '123',
        },
        safeData: {
          status: 'ACTIVE',
          amount: 19900,
        },
      };

      const sanitized = sanitizeAuditPayload(sensitivePayload) as any;

      expect(sanitized.credentials).toBe('[REDACTED]');
      expect(sanitized.profile.passwordHash).toBe('[REDACTED]');
      expect(sanitized.profile.salt).toBe('randomsalt');
      expect(sanitized.items[0].sessionToken).toBe('[REDACTED]');
      expect(sanitized.items[1].refreshToken).toBe('[REDACTED]');
      expect(sanitized.payment.creditCard).toBe('[REDACTED]');
      expect(sanitized.payment.cvv).toBe('[REDACTED]');

      // Non-sensitive data remains intact
      expect(sanitized.userId).toBe('u-1');
      expect(sanitized.email).toBe('test@vishkaraa.com');
      expect(sanitized.safeData.amount).toBe(19900);
    });

    it('safely handles circular references without infinite recursion', () => {
      const circular: any = { name: 'circular-test' };
      circular.self = circular;

      const sanitized = sanitizeAuditPayload(circular) as any;
      expect(sanitized.name).toBe('circular-test');
      expect(sanitized.self).toBe('[CIRCULAR]');
    });
  });

  // ─── 8. Environment Validation at Startup ──────────────────────────────────
  describe('8. Environment Configuration Validation', () => {
    const validEnv = {
      NODE_ENV: 'development',
      API_PORT: 3001,
      API_URL: 'http://localhost:3001',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      JWT_SECRET: 'a-sufficiently-long-secret-key-that-has-more-than-32-characters',
      JWT_REFRESH_SECRET: 'another-sufficiently-long-refresh-secret-with-more-than-32-chars',
      CORS_ORIGINS: 'http://localhost:5173',
    };

    it('accepts valid configuration', () => {
      const result = validateEnvironment(validEnv);
      expect(result.NODE_ENV).toBe('development');
      expect(result.API_PORT).toBe(3001);
    });

    it('rejects weak JWT_SECRET (< 32 chars) and does NOT print secret in error', () => {
      const invalidEnv = {
        ...validEnv,
        JWT_SECRET: 'too-short',
      };

      expect(() => validateEnvironment(invalidEnv)).toThrowError(/JWT_SECRET.*at least 32 characters/);
      // Ensure the secret value itself is never leaked in the error
      try {
        validateEnvironment(invalidEnv);
      } catch (err: any) {
        expect(err.message).not.toContain('too-short');
      }
    });

    it('rejects wildcard CORS with credentials enabled', () => {
      const invalidEnv = {
        ...validEnv,
        CORS_ORIGINS: '*',
      };

      expect(() => validateEnvironment(invalidEnv)).toThrowError(/Wildcard "\*" is prohibited/);
    });

    it('rejects dev placeholder secrets in production mode', () => {
      const prodEnvWithDevSecret = {
        ...validEnv,
        NODE_ENV: 'production',
        JWT_SECRET: 'dev-only-insecure-secret-placeholder-value-that-is-long-enough-64-chars',
      };

      expect(() => validateEnvironment(prodEnvWithDevSecret)).toThrowError(/dev placeholder values/);
    });
  });

  // ─── 9. Concurrent Active Cart Creation Protection ─────────────────────────
  describe('9. Concurrent Active Cart Creation Protection', () => {
    it('catches Prisma P2002 unique constraint error and falls back to existing active cart', async () => {
      const existingCart = {
        id: 'cart-winner',
        userId: 'user-1',
        status: 'ACTIVE',
        currency: 'INR',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPrisma: any = {
        cart: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(null) // First check: not found
            .mockResolvedValueOnce(existingCart), // Race resolution: found existing winner
          create: vi.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed on active cart', {
              code: 'P2002',
              clientVersion: '6.6.0',
            }),
          ),
        },
      };

      const { CartService } = await import('../src/cart/cart.service.js');
      const service = new CartService(mockPrisma, { logEvent: vi.fn() } as any);

      const result = await service.getOrCreateCart({ userId: 'user-1' });
      expect(result.cart.id).toBe('cart-winner');
      expect(mockPrisma.cart.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  // ─── 12. Media URL Security (Anti-SSRF) ────────────────────────────────────
  describe('12. Media URL Anti-SSRF Security', () => {
    it('validates public HTTPS URLs and rejects private/reserved IP ranges', async () => {
      const { validate } = await import('class-validator');
      const { CreateMediaValidationDto } = await import('../src/catalog/dto/media.dto.js');

      // Valid public CDN URL
      const validDto = new CreateMediaValidationDto();
      validDto.url = 'https://res.cloudinary.com/vishkaraa/image/upload/oil.jpg';
      let errors = await validate(validDto);
      expect(errors.length).toBe(0);

      // Invalid: Loopback address
      const loopbackDto = new CreateMediaValidationDto();
      loopbackDto.url = 'http://127.0.0.1:8080/internal.png';
      errors = await validate(loopbackDto);
      expect(errors.length).toBeGreaterThan(0);

      // Invalid: AWS / Cloud metadata service
      const metadataDto = new CreateMediaValidationDto();
      metadataDto.url = 'http://169.254.169.254/latest/meta-data/';
      errors = await validate(metadataDto);
      expect(errors.length).toBeGreaterThan(0);

      // Invalid: Private RFC 1918 range
      const privateDto = new CreateMediaValidationDto();
      privateDto.url = 'http://10.0.0.1/admin-asset.jpg';
      errors = await validate(privateDto);
      expect(errors.length).toBeGreaterThan(0);

      // Invalid: Embedded credentials in URL
      const credsDto = new CreateMediaValidationDto();
      credsDto.url = 'https://user:password@cdn.example.com/asset.jpg';
      errors = await validate(credsDto);
      expect(errors.length).toBeGreaterThan(0);
    }, 30000);
  });

  // ─── 13. Variant Price & compareAtPrice Validation ─────────────────────────
  describe('13. Variant Price and compareAtPrice Validation', () => {
    let productsService: any;
    let mockPrisma: any;

    beforeEach(async () => {
      mockPrisma = {
        product: { findUnique: vi.fn().mockResolvedValue({ id: 'prod-1' }) },
        productVariant: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      const { ProductsService } = await import('../src/catalog/products.service.js');
      productsService = new ProductsService(mockPrisma, { logEvent: vi.fn() } as any);
    });

    it('rejects variant creation with zero or negative price', async () => {
      const zeroPriceDto = {
        name: 'Free Oil',
        sku: 'OIL-FREE',
        price: 0,
      };

      await expect(
        productsService.createVariant('prod-1', zeroPriceDto, { id: 'admin-1', role: UserRole.ADMIN }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects compareAtPrice lower than price', async () => {
      const invalidCompareDto = {
        name: 'Discounted Oil',
        sku: 'OIL-DISC',
        price: 20000, // ₹200
        compareAtPrice: 15000, // ₹150 (invalid: was price cannot be less than sale price!)
      };

      await expect(
        productsService.createVariant('prod-1', invalidCompareDto, { id: 'admin-1', role: UserRole.ADMIN }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
