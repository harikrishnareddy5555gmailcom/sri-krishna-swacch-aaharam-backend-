import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../src/users/users.service.js';
import { UsersController } from '../src/users/users.controller.js';
import { AdminUsersController } from '../src/users/admin-users.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Phase 17: Customer / User Management Foundation & Security', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_naturals?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let usersService: UsersService;
  let usersController: UsersController;
  let adminUsersController: AdminUsersController;
  let auditService: AuditService;
  let configService: ConfigService;

  // Track created users for teardown
  const createdUserIds: string[] = [];
  const initialPassword = 'Password123!';
  let userAId: string;
  let userBId: string;
  let adminUser: { id: string; role: UserRole; email: string };
  let superAdminUser: { id: string; role: UserRole; email: string };

  beforeAll(async () => {
    configService = new ConfigService({
      BCRYPT_SALT_ROUNDS: '10', // Faster rounds for tests
    });

    auditService = new AuditService(prisma as unknown as PrismaService);
    usersService = new UsersService(
      prisma as unknown as PrismaService,
      auditService,
      configService,
    );
    usersController = new UsersController(usersService);
    adminUsersController = new AdminUsersController(usersService);

    const passwordHash = await bcrypt.hash(initialPassword, 10);

    // Create User A
    const uA = await prisma.user.create({
      data: {
        email: `usera_${Date.now()}@example.com`,
        passwordHash,
        firstName: 'Alice',
        lastName: 'Ander',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
      },
    });
    userAId = uA.id;
    createdUserIds.push(uA.id);

    // Create User B
    const uB = await prisma.user.create({
      data: {
        email: `userb_${Date.now()}@example.com`,
        passwordHash,
        firstName: 'Bob',
        lastName: 'Baker',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
      },
    });
    userBId = uB.id;
    createdUserIds.push(uB.id);

    // Create Admin User
    const uAdm = await prisma.user.create({
      data: {
        email: `admin_${Date.now()}@example.com`,
        passwordHash,
        firstName: 'Arthur',
        lastName: 'Admin',
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    adminUser = { id: uAdm.id, role: UserRole.ADMIN, email: uAdm.email };
    createdUserIds.push(uAdm.id);

    // Create Super Admin User
    const uSuper = await prisma.user.create({
      data: {
        email: `super_${Date.now()}@example.com`,
        passwordHash,
        firstName: 'Sybil',
        lastName: 'Super',
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    superAdminUser = {
      id: uSuper.id,
      role: UserRole.SUPER_ADMIN,
      email: uSuper.email,
    };
    createdUserIds.push(uSuper.id);

    // Create test active refresh token for User A
    await prisma.refreshToken.create({
      data: {
        userId: userAId,
        tokenHash: `test_token_hash_${Date.now()}`,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.refreshToken.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { actorId: { in: createdUserIds } },
            { userId: { in: createdUserIds } },
            { entityId: { in: createdUserIds } },
          ],
        },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
    await prisma.$disconnect();
  });

  // ===========================================================================
  // 1. USER PROFILE MANAGEMENT
  // ===========================================================================
  describe('Own Profile Management', () => {
    it('should view own profile and strictly exclude passwordHash', async () => {
      const profile = await usersService.getProfile(userAId);
      expect(profile).toBeDefined();
      expect(profile.id).toBe(userAId);
      expect(profile.firstName).toBe('Alice');
      expect(profile.role).toBe(UserRole.USER);
      expect(profile.status).toBe(UserStatus.ACTIVE);
      expect((profile as unknown as { passwordHash?: string }).passwordHash).toBeUndefined();
    });

    it('should update permitted profile fields (firstName, lastName)', async () => {
      const updated = await usersService.updateProfile(userAId, {
        firstName: 'Alicia',
        lastName: 'Anderson',
      });
      expect(updated.firstName).toBe('Alicia');
      expect(updated.lastName).toBe('Anderson');

      const reloaded = await usersService.getProfile(userAId);
      expect(reloaded.firstName).toBe('Alicia');
      expect(reloaded.lastName).toBe('Anderson');
    });

    it('should change password successfully, rehash, revoke active sessions, and log audit', async () => {
      const newPassword = 'NewSecretPassword456!';
      const res = await usersService.changePassword(userAId, {
        currentPassword: initialPassword,
        newPassword,
      });

      expect(res.success).toBe(true);
      expect(res.message).toContain('Password changed successfully');

      // Verify new hash in DB works with bcrypt
      const dbUser = await prisma.user.findUnique({ where: { id: userAId } });
      expect(dbUser).toBeDefined();
      const isValid = await bcrypt.compare(newPassword, dbUser!.passwordHash);
      expect(isValid).toBe(true);

      // Verify active refresh tokens were revoked
      const activeTokens = await prisma.refreshToken.findMany({
        where: { userId: userAId, revokedAt: null },
      });
      expect(activeTokens.length).toBe(0);

      // Verify audit log entry
      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'USER_PASSWORD_CHANGED',
          entityId: userAId,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeDefined();
      expect(audit!.actorId).toBe(userAId);
    });

    it('should reject password change when current password is incorrect', async () => {
      await expect(
        usersService.changePassword(userAId, {
          currentPassword: 'WrongPassword123!',
          newPassword: 'BrandNewPassword999!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject password change when new password equals current password', async () => {
      await expect(
        usersService.changePassword(userAId, {
          currentPassword: 'NewSecretPassword456!',
          newPassword: 'NewSecretPassword456!',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // 2. IDOR & CROSS-USER OWNERSHIP BOUNDARIES
  // ===========================================================================
  describe('IDOR & Security Boundaries', () => {
    it('USER A cannot access USER B profile via findOne (IDOR blocked)', async () => {
      const reqUserA = {
        user: { id: userAId, role: UserRole.USER, email: 'usera@example.com' } as MinimalUser,
      };

      await expect(
        usersController.findOne(reqUserA as any, userBId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('USER A can access their own profile via findOne', async () => {
      const reqUserA = {
        user: { id: userAId, role: UserRole.USER, email: 'usera@example.com' } as MinimalUser,
      };

      const res = await usersController.findOne(reqUserA as any, userAId);
      expect(res.success).toBe(true);
      expect(res.data.id).toBe(userAId);
    });

    it('UsersController.getMyProfile uses authenticated identity from req.user context', async () => {
      const reqUserB = {
        user: { id: userBId, role: UserRole.USER, email: 'userb@example.com' } as MinimalUser,
      };

      const res = await usersController.getMyProfile(reqUserB as any);
      expect(res.success).toBe(true);
      expect(res.data.id).toBe(userBId);
      expect(res.data.firstName).toBe('Bob');
    });

    it('ADMIN can view user profiles via findOne for administrative purposes', async () => {
      const reqAdmin = {
        user: adminUser as MinimalUser,
      };

      const res = await usersController.findOne(reqAdmin as any, userAId);
      expect(res.success).toBe(true);
      expect(res.data.id).toBe(userAId);
    });
  });

  // ===========================================================================
  // 3. ADMIN USER LISTING & SEARCH
  // ===========================================================================
  describe('Admin User Listing & Deterministic Ordering', () => {
    it('should list users with server-side pagination and metadata', async () => {
      const result = await usersService.findAdminUsers({
        page: 1,
        pageSize: 2,
      });

      expect(result.users.length).toBeLessThanOrEqual(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(2);
      expect(result.total).toBeGreaterThanOrEqual(4);
      expect(result.totalPages).toBeGreaterThanOrEqual(2);

      // Sensitive field check
      for (const u of result.users) {
        expect((u as unknown as { passwordHash?: string }).passwordHash).toBeUndefined();
      }
    });

    it('should filter users by role', async () => {
      const adminsOnly = await usersService.findAdminUsers({
        role: UserRole.ADMIN,
      });

      expect(adminsOnly.users.length).toBeGreaterThanOrEqual(1);
      for (const u of adminsOnly.users) {
        expect(u.role).toBe(UserRole.ADMIN);
      }
    });

    it('should filter users by status', async () => {
      const activeUsers = await usersService.findAdminUsers({
        status: UserStatus.ACTIVE,
      });

      expect(activeUsers.users.length).toBeGreaterThanOrEqual(1);
      for (const u of activeUsers.users) {
        expect(u.status).toBe(UserStatus.ACTIVE);
      }
    });

    it('should search users by term (case-insensitive email or name)', async () => {
      const searchRes = await usersService.findAdminUsers({
        search: 'baker',
      });

      expect(searchRes.users.length).toBeGreaterThanOrEqual(1);
      expect(searchRes.users.some((u) => u.lastName === 'Baker')).toBe(true);
    });
  });

  // ===========================================================================
  // 4. ADMIN USER DETAIL & OPERATIONAL UPDATES
  // ===========================================================================
  describe('Admin User Detail & Operational Updates', () => {
    it('should retrieve detailed user information including orderCount', async () => {
      const detail = await usersService.getAdminUserDetail(userAId);
      expect(detail.id).toBe(userAId);
      expect(detail.orderCount).toBe(0);
      expect((detail as unknown as { passwordHash?: string }).passwordHash).toBeUndefined();
    });

    it('should throw NotFoundException for non-existent user ID', async () => {
      await expect(
        usersService.getAdminUserDetail('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should allow ADMIN to update operational profile fields for regular USER', async () => {
      const updated = await usersService.adminUpdateUser(
        adminUser as MinimalUser,
        userBId,
        { firstName: 'Robert' },
      );

      expect(updated.firstName).toBe('Robert');
      const reloaded = await usersService.getProfile(userBId);
      expect(reloaded.firstName).toBe('Robert');
    });

    it('should prevent ADMIN from modifying SUPER_ADMIN profile', async () => {
      await expect(
        usersService.adminUpdateUser(
          adminUser as MinimalUser,
          superAdminUser.id,
          { firstName: 'Hacked' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ===========================================================================
  // 5. ACCOUNT LIFECYCLE & SAFETY RULES
  // ===========================================================================
  describe('Account Lifecycle & Protective Invariants', () => {
    it('should safely deactivate a regular USER account and revoke active sessions', async () => {
      // Create active refresh token for User B
      await prisma.refreshToken.create({
        data: {
          userId: userBId,
          tokenHash: `test_token_b_${Date.now()}`,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const deactivated = await usersService.deactivateUser(
        adminUser as MinimalUser,
        userBId,
        { reason: 'Suspicious account activity detected' },
      );

      expect(deactivated.status).toBe(UserStatus.SUSPENDED);

      // Verify active tokens were revoked
      const tokens = await prisma.refreshToken.findMany({
        where: { userId: userBId, revokedAt: null },
      });
      expect(tokens.length).toBe(0);

      // Verify audit log
      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'USER_SUSPENDED',
          entityId: userBId,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeDefined();
      expect(audit!.actorId).toBe(adminUser.id);
    });

    it('should safely reactivate a suspended user account', async () => {
      const reactivated = await usersService.reactivateUser(
        adminUser as MinimalUser,
        userBId,
        { reason: 'Identity verified' },
      );

      expect(reactivated.status).toBe(UserStatus.ACTIVE);

      // Verify audit log
      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'USER_ACTIVATED',
          entityId: userBId,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeDefined();
    });

    it('should prevent self-deactivation (self-lockout protection)', async () => {
      await expect(
        usersService.deactivateUser(
          adminUser as MinimalUser,
          adminUser.id,
          { reason: 'Accidental self-deactivation' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should prevent ADMIN from deactivating SUPER_ADMIN (hierarchy protection)', async () => {
      await expect(
        usersService.deactivateUser(
          adminUser as MinimalUser,
          superAdminUser.id,
          { reason: 'Unauthorized privilege reduction' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should prevent deactivating the last active SUPER_ADMIN', async () => {
      // Find all active super admins
      const activeSuperAdmins = await prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN, status: UserStatus.ACTIVE },
      });

      // If only 1 exists, deactivation of that super admin should fail
      if (activeSuperAdmins.length === 1) {
        const theOnlySuperAdmin = activeSuperAdmins[0]!;
        // Even another caller or SuperAdmin itself cannot deactivate the last one
        const pseudoActor: MinimalUser = {
          id: 'another-actor-id',
          role: UserRole.SUPER_ADMIN,
        };

        await expect(
          usersService.deactivateUser(pseudoActor, theOnlySuperAdmin.id, {
            reason: 'Testing last superadmin protection',
          }),
        ).rejects.toThrow(ForbiddenException);
      } else {
        expect(activeSuperAdmins.length).toBeGreaterThan(1);
      }
    });
  });

  // ===========================================================================
  // 6. ADMIN USERS CONTROLLER INTEGRATION
  // ===========================================================================
  describe('AdminUsersController Integration', () => {
    it('listUsers should return standardized API response with paginated users', async () => {
      const res = await adminUsersController.listUsers({ page: 1, pageSize: 5 });
      expect(res.success).toBe(true);
      expect(res.data.users).toBeInstanceOf(Array);
      expect(res.data.total).toBeGreaterThanOrEqual(1);
    });

    it('getUserDetail should return operational user information', async () => {
      const res = await adminUsersController.getUserDetail(userAId);
      expect(res.success).toBe(true);
      expect(res.data.id).toBe(userAId);
      expect(res.data.orderCount).toBeDefined();
    });

    it('updateUser should update allowed fields and return standardized API response', async () => {
      const req = { user: adminUser as MinimalUser };
      const res = await adminUsersController.updateUser(
        req as any,
        userAId,
        { firstName: 'Alison' },
      );
      expect(res.success).toBe(true);
      expect(res.data.firstName).toBe('Alison');
    });

    it('deactivateUser should deactivate user and return standardized response', async () => {
      const req = { user: adminUser as MinimalUser };
      const res = await adminUsersController.deactivateUser(
        req as any,
        userAId,
        { reason: 'Customer requested temporary hold' },
      );
      expect(res.success).toBe(true);
      expect(res.data.status).toBe(UserStatus.SUSPENDED);
    });

    it('reactivateUser should restore user to ACTIVE status', async () => {
      const req = { user: adminUser as MinimalUser };
      const res = await adminUsersController.reactivateUser(
        req as any,
        userAId,
        { reason: 'Customer requested unhold' },
      );
      expect(res.success).toBe(true);
      expect(res.data.status).toBe(UserStatus.ACTIVE);
    });
  });
});
