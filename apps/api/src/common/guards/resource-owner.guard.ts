import {
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@vishkaraa/types';
import type { Request } from 'express';
import { PermissionsService, type MinimalUser } from '../../permissions/permissions.service.js';
import {
  EntityOwnershipService,
  type EntityType,
} from '../services/entity-ownership.service.js';

export interface OwnershipOptions {
  paramKey?: string; // Route param containing resource ID (default 'id' or 'userId')
  entityType?: EntityType; // Entity type to resolve: 'USER' | 'CART' | 'ORDER' | 'RETURN' | 'REFUND' (default: 'USER')
  adminBypassPermissions?: string[]; // Specific granular permissions required for admin bypass (never automatic)
}

export const RESOURCE_OWNER_KEY = 'resource_owner_key';

interface AuthenticatedRequest extends Request {
  user?: MinimalUser;
  params: Record<string, string>;
}

@Injectable()
export class ResourceOwnerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
    private readonly entityOwnershipService?: EntityOwnershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<OwnershipOptions>(
      RESOURCE_OWNER_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User is not authenticated');
    }

    // 1. Super Admin always has full platform access
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }

    // 2. Extract requested ID from route parameters
    const paramKey = options.paramKey || 'id';
    const resourceId =
      request.params[paramKey] || request.params['userId'];

    if (!resourceId) {
      return true; // No ID in params to check against
    }

    const entityType = options.entityType ?? 'USER';

    // 3. Delegate to EntityOwnershipService if available
    if (this.entityOwnershipService) {
      const result = await this.entityOwnershipService.isAuthorized(
        user,
        entityType,
        resourceId,
        options.adminBypassPermissions,
      );
      if (result.authorized) {
        return true;
      }
      throw new ForbiddenException(
        'Access Denied: You do not have permission to access or modify resources belonging to another user (IDOR Protection)',
      );
    }

    // Fallback: Direct USER parameter check (for backward compatibility when service not injected)
    if (user.id === resourceId) {
      return true;
    }

    if (
      user.role === UserRole.ADMIN &&
      options.adminBypassPermissions &&
      options.adminBypassPermissions.length > 0
    ) {
      for (const perm of options.adminBypassPermissions) {
        const hasPermission = await this.permissionsService.can(user, perm);
        if (hasPermission) {
          return true;
        }
      }
    }

    throw new ForbiddenException(
      'Access Denied: You do not have permission to access or modify resources belonging to another user (IDOR Protection)',
    );
  }
}
