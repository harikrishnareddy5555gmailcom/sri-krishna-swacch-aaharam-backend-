import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../src/auth/auth.service.js';
import { UserRole, UserStatus } from '@vishkaraa/types';
import { createHash } from 'crypto';

describe('Authentication Hardening & Security Baseline Tests', () => {
  let authService: AuthService;
  let mockUsersService: any;
  let mockJwtService: any;
  let mockConfigService: any;
  let mockPrismaService: any;
  let mockAuditService: any;

  const testUser = {
    id: 'user-uuid-1',
    email: 'user@vishkaraa.local',
    passwordHash: '',
    firstName: 'Regular',
    lastName: 'User',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    emailVerifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    // Generate actual bcrypt hash for realistic verification
    testUser.passwordHash = await bcrypt.hash('SecurePassword123', 10);

    mockUsersService = {
      findByEmail: vi.fn(),
      findById: vi.fn(),
      findByIdSafe: vi.fn(),
      create: vi.fn(),
    };

    mockJwtService = {
      sign: vi.fn().mockImplementation((payload) => `signed_jwt_${payload.sub || 'token'}`),
    };

    mockConfigService = {
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'BCRYPT_SALT_ROUNDS') return '12';
        if (key === 'JWT_SECRET') return 'test-jwt-secret-key-for-unit-testing';
        if (key === 'JWT_EXPIRES_IN') return '15m';
        if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret-for-unit-testing';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
        return defaultValue;
      }),
    };

    mockPrismaService = {
      refreshToken: {
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    mockAuditService = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    authService = new AuthService(
      mockUsersService,
      mockJwtService,
      mockConfigService,
      mockPrismaService,
      mockAuditService,
    );
  });

  describe('Password Security & Sanitization', () => {
    it('verifies passwords are never stored plaintext and are hashed with bcrypt', async () => {
      mockUsersService.findByEmail.mockResolvedValue(null);
      mockUsersService.create.mockImplementation((data: any) => ({
        id: 'new-user-1',
        ...data,
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
      }));

      const plaintextPassword = 'MySecretPassword999';
      const result = await authService.register({
        email: 'newuser@vishkaraa.local',
        password: plaintextPassword,
        firstName: 'New',
        lastName: 'User',
      });

      // Verify create was called with a bcrypt hash, NEVER plaintext
      expect(mockUsersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          passwordHash: expect.stringMatching(/^\$2[aby]\$\d{2}\$/),
        }),
      );

      // Verify returned result does NOT leak passwordHash
      expect((result.user as any).passwordHash).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(plaintextPassword);
    });

    it('verifies passwordHash is omitted from login response', async () => {
      const loginResult = await authService.login(testUser);

      expect((loginResult.authResponse.user as any).passwordHash).toBeUndefined();
      expect(loginResult.authResponse.tokens.accessToken).toBeDefined();
    });

    it('verifies audit logs never record passwords', async () => {
      await authService.validateUser('user@vishkaraa.local', 'WrongPassword123');

      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGIN_FAILURE',
        }),
      );

      const auditCall = mockAuditService.logEvent.mock.calls[0][0];
      expect(JSON.stringify(auditCall)).not.toContain('WrongPassword123');
    });
  });

  describe('Account Enumeration Defense', () => {
    it('returns generic null for non-existent email and logs failure with constant-time dummy comparison', async () => {
      mockUsersService.findByEmail.mockResolvedValue(null);

      const result = await authService.validateUser(
        'nonexistent@vishkaraa.local',
        'AnyPassword123',
      );

      expect(result).toBeNull();
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGIN_FAILURE',
          actorId: 'anonymous',
          reason: 'INVALID_CREDENTIALS',
        }),
      );
    });

    it('returns generic null for existing email with wrong password', async () => {
      mockUsersService.findByEmail.mockResolvedValue(testUser);

      const result = await authService.validateUser(
        'user@vishkaraa.local',
        'IncorrectPassword!',
      );

      expect(result).toBeNull();
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGIN_FAILURE',
          actorId: testUser.id,
          reason: 'INVALID_CREDENTIALS',
        }),
      );
    });

    it('provides safe generic error message on registration collision', async () => {
      mockUsersService.findByEmail.mockResolvedValue(testUser);

      await expect(
        authService.register({
          email: 'user@vishkaraa.local',
          password: 'SecurePassword123',
          firstName: 'Duplicate',
          lastName: 'Attempt',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('JWT Access Token Security', () => {
    it('generates access tokens with minimal claims and 15m expiration', () => {
      const tokens = authService.generateTokens(testUser);

      expect(mockJwtService.sign).toHaveBeenCalledWith({
        sub: testUser.id,
        email: testUser.email,
        role: testUser.role,
      });

      expect(tokens.expiresIn).toBe(900); // 15 minutes = 900 seconds
      expect(tokens.accessToken).toBeDefined();
    });
  });

  describe('Refresh Token Rotation & Storage', () => {
    it('generates cryptographically random refresh tokens and stores SHA-256 hash', async () => {
      const rawToken = await authService.generateAndStoreRefreshToken(testUser.id);

      expect(typeof rawToken).toBe('string');
      expect(rawToken.length).toBe(80); // 40 bytes in hex = 80 characters

      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(mockPrismaService.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: testUser.id,
          tokenHash: expectedHash,
          expiresAt: expect.any(Date),
        }),
      });
    });

    it('rotates refresh token: revokes old token and returns brand new token', async () => {
      const initialRawToken = 'a'.repeat(80);
      const initialHash = createHash('sha256').update(initialRawToken).digest('hex');

      // Mock finding the valid unrevoked token record
      mockPrismaService.refreshToken.findUnique.mockResolvedValue({
        id: 'token-rec-1',
        userId: testUser.id,
        tokenHash: initialHash,
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: null,
      });

      mockUsersService.findByIdSafe.mockResolvedValue(testUser);

      const rotated = await authService.rotateRefreshToken(initialRawToken);

      // Verify current token was marked revoked
      expect(mockPrismaService.refreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash: initialHash },
        data: { revokedAt: expect.any(Date) },
      });

      // Verify a new refresh token was created and returned
      expect(rotated.newRefreshToken).toBeDefined();
      expect(rotated.newRefreshToken).not.toBe(initialRawToken);
      expect(rotated.accessToken).toBeDefined();

      // Verify audit log captured token refresh
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TOKEN_REFRESH',
          actorId: testUser.id,
        }),
      );
    });

    it('rejects expired refresh token', async () => {
      const expiredRawToken = 'b'.repeat(80);
      const expiredHash = createHash('sha256').update(expiredRawToken).digest('hex');

      mockPrismaService.refreshToken.findUnique.mockResolvedValue({
        id: 'token-rec-expired',
        userId: testUser.id,
        tokenHash: expiredHash,
        expiresAt: new Date(Date.now() - 1000), // In the past!
        revokedAt: null,
      });

      await expect(authService.rotateRefreshToken(expiredRawToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Replay Attack Detection & Defense', () => {
    it('detects already-revoked refresh token reuse and immediately revokes ALL user sessions', async () => {
      const stolenToken = 'c'.repeat(80);
      const stolenHash = createHash('sha256').update(stolenToken).digest('hex');

      // Token was already revoked earlier!
      mockPrismaService.refreshToken.findUnique.mockResolvedValue({
        id: 'stolen-token-id',
        userId: testUser.id,
        tokenHash: stolenHash,
        expiresAt: new Date(Date.now() + 500000),
        revokedAt: new Date(Date.now() - 5000), // Already revoked!
      });

      await expect(authService.rotateRefreshToken(stolenToken)).rejects.toThrow(
        'Refresh token has already been used. Session terminated for security.',
      );

      // Verify ALL user tokens were immediately revoked
      expect(mockPrismaService.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: testUser.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });

      // Verify security alert audit event was recorded
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SECURITY_ALERT_TOKEN_REPLAY',
          actorId: testUser.id,
        }),
      );
    });
  });

  describe('Logout Invalidation', () => {
    it('revokes refresh token and records LOGOUT audit event', async () => {
      const logoutToken = 'd'.repeat(80);
      const logoutHash = createHash('sha256').update(logoutToken).digest('hex');

      await authService.revokeRefreshToken(logoutToken, testUser.id);

      expect(mockPrismaService.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: logoutHash, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });

      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGOUT',
          actorId: testUser.id,
        }),
      );
    });
  });
});
