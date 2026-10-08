import { Injectable } from '@nestjs/common';
import { UserRole, type RoleDefinition } from '@vishkaraa/types';
import { DEFAULT_ROLE_PERMISSIONS } from '@vishkaraa/shared';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async getAllRoles(): Promise<RoleDefinition[]> {
    try {
      const dbRoles = await this.prisma.role.findMany({
        include: {
          rolePermissions: true,
        },
      });

      if (dbRoles && dbRoles.length > 0) {
        return dbRoles.map((r) => ({
          id: r.id,
          name: r.name as UserRole,
          description: r.description ?? '',
          isSystem: r.isSystem,
          permissions: r.rolePermissions.map((rp) => rp.permissionKey),
        }));
      }
    } catch {
      // Fallback
    }

    return [
      {
        id: 'role-super-admin',
        name: UserRole.SUPER_ADMIN,
        description: 'Platform Owner — Unrestricted authority',
        isSystem: true,
        permissions: DEFAULT_ROLE_PERMISSIONS[UserRole.SUPER_ADMIN],
      },
      {
        id: 'role-admin',
        name: UserRole.ADMIN,
        description: 'Operations Manager — Granular admin permissions',
        isSystem: true,
        permissions: DEFAULT_ROLE_PERMISSIONS[UserRole.ADMIN],
      },
      {
        id: 'role-user',
        name: UserRole.USER,
        description: 'Standard Consumer User',
        isSystem: true,
        permissions: DEFAULT_ROLE_PERMISSIONS[UserRole.USER],
      },
    ];
  }
}
