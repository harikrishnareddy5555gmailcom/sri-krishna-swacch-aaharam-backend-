import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  UserRole,
  PermissionEffect,
  type PermissionDefinition,
  type UserEffectivePermissions,
  type FeatureKey,
} from '@vishkaraa/types';
import {
  PERMISSION_REGISTRY,
  isPermissionAssignableToAdmin,
  evaluateEffectivePermissions,
  canPerform,
} from '@vishkaraa/shared';
import type {
  RolePermission as PrismaRolePermission,
  UserPermission as PrismaUserPermission,
} from '@prisma/client';
import { PermissionEffect as PrismaPermissionEffect } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

export interface MinimalUser {
  id: string;
  role: UserRole;
  email?: string;
}

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  // In-memory fallback caches if database is unseeded/unreachable
  private inMemoryUserGrants = new Map<string, Map<string, PermissionEffect>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Authoritative check: can a user execute an action requiring permissionKey?
   * Evaluates Super Admin authority, user denials, user grants, and role baselines.
   */
  async can(user: MinimalUser, permissionKey: string): Promise<boolean> {
    if (!user) {
      return false;
    }

    // Super Admin: platform-wide permissions by design
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }

    const effective = await this.getEffectivePermissions(user);
    return canPerform(effective.allowed, permissionKey);
  }

  /**
   * True if user has ALL required permissions.
   */
  async canAll(user: MinimalUser, permissionKeys: string[]): Promise<boolean> {
    if (!permissionKeys || permissionKeys.length === 0) {
      return true;
    }
    for (const key of permissionKeys) {
      if (!(await this.can(user, key))) {
        return false;
      }
    }
    return true;
  }

  /**
   * True if user has AT LEAST ONE of the required permissions.
   */
  async canAny(user: MinimalUser, permissionKeys: string[]): Promise<boolean> {
    if (!permissionKeys || permissionKeys.length === 0) {
      return true;
    }
    for (const key of permissionKeys) {
      if (await this.can(user, key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Computes authoritative effective permissions for a user.
   */
  async getEffectivePermissions(
    user: MinimalUser,
  ): Promise<UserEffectivePermissions> {
    if (user.role === UserRole.SUPER_ADMIN) {
      return {
        userId: user.id,
        role: user.role,
        allowed: Object.keys(PERMISSION_REGISTRY),
        denied: [],
        isSuperAdmin: true,
      };
    }

    // Attempt to load from database
    let dbRolePermissions: PrismaRolePermission[] = [];
    let dbUserPermissions: PrismaUserPermission[] = [];

    try {
      [dbRolePermissions, dbUserPermissions] = await Promise.all([
        this.prisma.rolePermission.findMany({
          where: { roleName: user.role },
        }),
        this.prisma.userPermission.findMany({
          where: { userId: user.id },
        }),
      ]);
    } catch {
      // In-memory fallback
      const inMemoryGrants = this.inMemoryUserGrants.get(user.id);
      if (inMemoryGrants) {
        dbUserPermissions = Array.from(inMemoryGrants.entries()).map(
          ([k, effect], idx) => ({
            id: `mem-${idx}`,
            userId: user.id,
            permissionKey: k,
            effect: effect as unknown as PrismaPermissionEffect,
            grantedById: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );
      }
    }

    return evaluateEffectivePermissions({
      userId: user.id,
      role: user.role,
      rolePermissions: dbRolePermissions.map((rp) => ({
        id: rp.id,
        roleName: rp.roleName as UserRole,
        permissionKey: rp.permissionKey,
        effect: rp.effect as PermissionEffect,
      })),
      userPermissions: dbUserPermissions.map((up) => ({
        id: up.id,
        userId: up.userId,
        permissionKey: up.permissionKey,
        effect: up.effect as PermissionEffect,
        grantedById: up.grantedById ?? undefined,
        createdAt: up.createdAt ?? new Date(),
        updatedAt: up.updatedAt ?? new Date(),
      })),
    });
  }

  /**
   * Grants or explicitly denies a permission to a user.
   *
   * STRICT ADMIN BOUNDARY:
   * 1. ADMIN cannot grant any permission that is not assignable to admin.
   * 2. ADMIN cannot grant a permission that the ADMIN itself does not hold.
   * 3. ADMIN cannot alter a SUPER_ADMIN's permissions.
   * 4. Enforced strictly server-side.
   */
  async grantPermission(
    actor: MinimalUser,
    targetUserId: string,
    permissionKey: string,
    effect: PermissionEffect = PermissionEffect.ALLOW,
    reason?: string,
  ): Promise<void> {
    // 1. Verify permission exists
    const permDef = PERMISSION_REGISTRY[permissionKey];
    if (!permDef) {
      throw new NotFoundException(
        `Permission '${permissionKey}' is not registered`,
      );
    }

    // 2. Admin Boundary Enforcement
    if (actor.role === UserRole.ADMIN) {
      // Check if permission is assignable
      if (!isPermissionAssignableToAdmin(permissionKey)) {
        this.logger.warn(
          `Security violation: Admin ${actor.id} attempted to grant non-delegable permission ${permissionKey}`,
        );
        throw new ForbiddenException(
          `Admins cannot grant permission '${permissionKey}' — restricted to Super Admin`,
        );
      }

      // Check if actor holds the permission
      const actorCan = await this.can(actor, permissionKey);
      if (!actorCan) {
        this.logger.warn(
          `Security violation: Admin ${actor.id} attempted to grant permission ${permissionKey} which they do not possess`,
        );
        throw new ForbiddenException(
          `Admins cannot grant permissions they do not possess themselves`,
        );
      }
    } else if (actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only Super Admins and authorized Admins can manage permissions',
      );
    }

    // 3. Prevent non-SuperAdmin from modifying SuperAdmin target
    try {
      const targetUser = await this.prisma.user.findUnique({
        where: { id: targetUserId },
      });
      if (
        targetUser &&
        (targetUser.role as unknown as UserRole) === UserRole.SUPER_ADMIN &&
        actor.role !== UserRole.SUPER_ADMIN
      ) {
        throw new ForbiddenException(
          'Cannot modify permissions of a Super Admin',
        );
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
    }

    // 4. Persist grant
    try {
      const prismaEffect = effect as unknown as PrismaPermissionEffect;
      await this.prisma.userPermission.upsert({
        where: {
          userId_permissionKey: {
            userId: targetUserId,
            permissionKey,
          },
        },
        update: {
          effect: prismaEffect,
          grantedById: actor.id,
        },
        create: {
          userId: targetUserId,
          permissionKey,
          effect: prismaEffect,
          grantedById: actor.id,
        },
      });
    } catch {
      // In-memory fallback
      if (!this.inMemoryUserGrants.has(targetUserId)) {
        this.inMemoryUserGrants.set(targetUserId, new Map());
      }
      this.inMemoryUserGrants.get(targetUserId)!.set(permissionKey, effect);
    }

    // 5. Emit Audit Log Event
    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action:
        effect === PermissionEffect.ALLOW
          ? 'PERMISSION_GRANTED'
          : 'PERMISSION_DENIED',
      entityType: 'UserPermission',
      entityId: `${targetUserId}:${permissionKey}`,
      newValue: { permissionKey, effect, targetUserId },
      reason,
    });
  }

  /**
   * Revokes a direct permission grant/denial from a user.
   */
  async revokePermission(
    actor: MinimalUser,
    targetUserId: string,
    permissionKey: string,
    reason?: string,
  ): Promise<void> {
    if (actor.role === UserRole.ADMIN) {
      if (!isPermissionAssignableToAdmin(permissionKey)) {
        throw new ForbiddenException(
          `Admins cannot revoke permission '${permissionKey}' — restricted to Super Admin`,
        );
      }
    } else if (actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only Super Admins and authorized Admins can manage permissions',
      );
    }

    try {
      await this.prisma.userPermission.deleteMany({
        where: {
          userId: targetUserId,
          permissionKey,
        },
      });
    } catch {
      const grants = this.inMemoryUserGrants.get(targetUserId);
      if (grants) {
        grants.delete(permissionKey);
      }
    }

    // Audit log event
    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: 'PERMISSION_REVOKED',
      entityType: 'UserPermission',
      entityId: `${targetUserId}:${permissionKey}`,
      reason,
    });
  }

  /**
   * Returns all system permissions with assignment metadata.
   */
  async getAllPermissions(): Promise<PermissionDefinition[]> {
    try {
      const dbPerms = await this.prisma.permission.findMany();
      if (dbPerms && dbPerms.length > 0) {
        return dbPerms.map((p) => ({
          id: p.id,
          key: p.key,
          resource: p.resource,
          action: p.action,
          description: p.description ?? '',
          featureKey: (p.featureKey as FeatureKey) ?? undefined,
          isAssignableToAdmin: p.isAssignableToAdmin,
        }));
      }
    } catch {
      // Fallback
    }

    return Object.values(PERMISSION_REGISTRY);
  }

  /**
   * Retrieves effective permissions and explicit overrides for a target user.
   */
  async getTargetUserPermissions(targetUserId: string): Promise<{
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
    allowed: string[];
    denied: string[];
    isSuperAdmin: boolean;
    overrides: Array<{ permissionKey: string; effect: PermissionEffect }>;
  }> {
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      const mockStaffMap: Record<
        string,
        { email: string; firstName: string; lastName: string; role: UserRole }
      > = {
        'admin-ops-02': {
          email: 'operations@vishkaraa.com',
          firstName: 'Arjun',
          lastName: 'Sharma',
          role: UserRole.ADMIN,
        },
        'admin-catalog-03': {
          email: 'catalog.lead@vishkaraa.com',
          firstName: 'Priya',
          lastName: 'Nair',
          role: UserRole.ADMIN,
        },
        'admin-dispatch-04': {
          email: 'logistics@vishkaraa.com',
          firstName: 'Rohan',
          lastName: 'Verma',
          role: UserRole.ADMIN,
        },
        'super-admin-01': {
          email: 'admin@vishkaraa.com',
          firstName: 'Super',
          lastName: 'Administrator',
          role: UserRole.SUPER_ADMIN,
        },
      };

      const mock = mockStaffMap[targetUserId] ?? (
        targetUserId.startsWith('admin-') || targetUserId.startsWith('super-admin-')
          ? {
              email: `${targetUserId}@vishkaraa.com`,
              firstName: 'Staff',
              lastName: 'Member',
              role: targetUserId.startsWith('super-admin-') ? UserRole.SUPER_ADMIN : UserRole.ADMIN,
            }
          : null
      );

      if (mock) {
        const effective = await this.getEffectivePermissions({
          id: targetUserId,
          role: mock.role,
          email: mock.email,
        });

        return {
          userId: targetUserId,
          email: mock.email,
          firstName: mock.firstName,
          lastName: mock.lastName,
          role: mock.role,
          allowed: effective.allowed,
          denied: effective.denied,
          isSuperAdmin: effective.isSuperAdmin,
          overrides: [],
        };
      }

      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    const effective = await this.getEffectivePermissions({
      id: targetUser.id,
      role: targetUser.role as unknown as UserRole,
      email: targetUser.email,
    });

    let overrides: Array<{ permissionKey: string; effect: PermissionEffect }> = [];
    try {
      const dbOverrides = await this.prisma.userPermission.findMany({
        where: { userId: targetUserId },
      });
      overrides = dbOverrides.map((up) => ({
        permissionKey: up.permissionKey,
        effect: up.effect as unknown as PermissionEffect,
      }));
    } catch {
      const memGrants = this.inMemoryUserGrants.get(targetUserId);
      if (memGrants) {
        overrides = Array.from(memGrants.entries()).map(([k, effect]) => ({
          permissionKey: k,
          effect,
        }));
      }
    }

    return {
      userId: targetUser.id,
      email: targetUser.email,
      firstName: targetUser.firstName,
      lastName: targetUser.lastName,
      role: targetUser.role as unknown as UserRole,
      allowed: effective.allowed,
      denied: effective.denied,
      isSuperAdmin: targetUser.role === (UserRole.SUPER_ADMIN as string),
      overrides,
    };
  }
}

