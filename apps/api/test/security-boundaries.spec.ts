import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  UserRole,
  FeatureKey,
  FeatureStatus,
  Permissions,
  PermissionEffect,
} from '@vishkaraa/types';
import { PermissionsService } from '../src/permissions/permissions.service.js';
import { FeaturesService } from '../src/features/features.service.js';

describe('Security Boundaries & Authorization Enforcement', () => {
  let mockPrisma: any;
  let mockAudit: any;
  let permissionsService: PermissionsService;
  let featuresService: FeaturesService;

  beforeEach(() => {
    mockPrisma = {
      rolePermission: { findMany: vi.fn().mockResolvedValue([]) },
      userPermission: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      permission: { findMany: vi.fn().mockResolvedValue([]) },
      feature: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };

    mockAudit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    permissionsService = new PermissionsService(mockPrisma, mockAudit);
    featuresService = new FeaturesService(
      mockPrisma,
      mockAudit,
      permissionsService,
    );
  });

  describe('Admin Delegation Boundary', () => {
    const adminActor = {
      id: 'admin-1',
      role: UserRole.ADMIN,
      email: 'admin@vishkaraa.local',
    };

    it('denies ADMIN from granting non-delegable Super Admin permissions', async () => {
      // PERMISSIONS.MANAGE is strictly non-assignable to admin
      await expect(
        permissionsService.grantPermission(
          adminActor,
          'target-user-1',
          Permissions.PERMISSIONS_MANAGE,
          PermissionEffect.ALLOW,
        ),
      ).rejects.toThrow(ForbiddenException);

      // Verify audit was not logged as granted
      expect(mockAudit.logEvent).not.toHaveBeenCalled();
    });

    it('denies ADMIN from granting permissions they do not possess', async () => {
      // Admin by default does NOT have REFUNDS.APPROVE
      await expect(
        permissionsService.grantPermission(
          adminActor,
          'target-user-1',
          Permissions.REFUNDS_APPROVE,
          PermissionEffect.ALLOW,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('denies standard USER from attempting to grant any permissions', async () => {
      const userActor = {
        id: 'user-1',
        role: UserRole.USER,
        email: 'user@vishkaraa.local',
      };

      await expect(
        permissionsService.grantPermission(
          userActor,
          'target-user-2',
          Permissions.ORDERS_VIEW,
          PermissionEffect.ALLOW,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('denies ADMIN from altering permissions of a SUPER_ADMIN user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'super-admin-target',
        role: UserRole.SUPER_ADMIN,
      });

      await expect(
        permissionsService.grantPermission(
          adminActor,
          'super-admin-target',
          Permissions.ORDERS_VIEW,
          PermissionEffect.DENY,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows SUPER_ADMIN to grant any registered permission and emits audit event', async () => {
      const superActor = {
        id: 'super-1',
        role: UserRole.SUPER_ADMIN,
        email: 'super@vishkaraa.local',
      };

      await permissionsService.grantPermission(
        superActor,
        'target-admin-1',
        Permissions.REFUNDS_APPROVE,
        PermissionEffect.ALLOW,
        'Approved by operations lead',
      );

      expect(mockAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PERMISSION_GRANTED',
          actorId: 'super-1',
          entityType: 'UserPermission',
        }),
      );
    });
  });

  describe('Feature Dependency & Status Boundaries', () => {
    const superActor = {
      id: 'super-1',
      role: UserRole.SUPER_ADMIN,
      email: 'super@vishkaraa.local',
    };

    it('prevents activating a feature when its required dependency is disabled', async () => {
      // Simulate CART being INACTIVE and CHECKOUT being INACTIVE
      mockPrisma.feature.findMany.mockResolvedValue([
        {
          key: FeatureKey.CART,
          status: FeatureStatus.INACTIVE,
          dependencies: [FeatureKey.PRODUCTS],
          defaultEnabled: true,
        },
        {
          key: FeatureKey.CHECKOUT,
          status: FeatureStatus.INACTIVE,
          dependencies: [FeatureKey.CART],
          defaultEnabled: true,
        },
      ]);

      // CHECKOUT depends on CART — activating CHECKOUT must fail!
      await expect(
        featuresService.updateFeatureStatus(
          FeatureKey.CHECKOUT,
          FeatureStatus.ACTIVE,
          superActor,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('prevents deactivating a feature if active features depend on it', async () => {
      // Simulate both CART and CHECKOUT being ACTIVE
      mockPrisma.feature.findMany.mockResolvedValue([
        {
          key: FeatureKey.CART,
          status: FeatureStatus.ACTIVE,
          dependencies: [FeatureKey.PRODUCTS],
          defaultEnabled: true,
        },
        {
          key: FeatureKey.CHECKOUT,
          status: FeatureStatus.ACTIVE,
          dependencies: [FeatureKey.CART],
          defaultEnabled: true,
        },
      ]);

      // Deactivating CART must fail because CHECKOUT is active and depends on CART!
      await expect(
        featuresService.updateFeatureStatus(
          FeatureKey.CART,
          FeatureStatus.INACTIVE,
          superActor,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ServiceUnavailableException when a feature is in MAINTENANCE', async () => {
      mockPrisma.feature.findMany.mockResolvedValue([
        {
          key: FeatureKey.ORDERS,
          status: FeatureStatus.MAINTENANCE,
          dependencies: [FeatureKey.CHECKOUT],
          defaultEnabled: true,
        },
      ]);

      const regularUser = { id: 'usr-1', role: UserRole.USER };

      await expect(
        featuresService.isFeatureEnabled(FeatureKey.ORDERS, regularUser),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('allows Super Admin to bypass MAINTENANCE status for diagnostics', async () => {
      mockPrisma.feature.findMany.mockResolvedValue([
        {
          key: FeatureKey.ORDERS,
          status: FeatureStatus.MAINTENANCE,
          dependencies: [],
          defaultEnabled: true,
        },
      ]);

      const superUser = { id: 'super-1', role: UserRole.SUPER_ADMIN };
      const enabled = await featuresService.isFeatureEnabled(
        FeatureKey.ORDERS,
        superUser,
      );

      expect(enabled).toBe(true);
    });

    it('returns false for unknown feature', async () => {
      const enabled = await featuresService.isFeatureEnabled(
        'UNKNOWN_KEY' as FeatureKey,
      );
      expect(enabled).toBe(false);
    });
  });
});
