import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@vishkaraa/types';
import { PrismaService } from '../../database/prisma.service.js';
import { PermissionsService, type MinimalUser } from '../../permissions/permissions.service.js';

export type EntityType = 'USER' | 'CART' | 'ORDER' | 'RETURN' | 'REFUND' | 'CHECKOUT' | 'PAYMENT';

@Injectable()
export class EntityOwnershipService {
  private readonly logger = new Logger(EntityOwnershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * Resolves the authoritative owner (userId) for a given entity from the database.
   */
  async resolveOwnerId(entityType: EntityType, entityId: string): Promise<string | null> {
    if (!entityId) return null;

    try {
      switch (entityType) {
        case 'USER':
          return entityId;

        case 'CART': {
          const cart = await this.prisma.cart.findUnique({
            where: { id: entityId },
            select: { userId: true },
          });
          return cart?.userId ?? null;
        }

        case 'CHECKOUT': {
          const session = await this.prisma.checkoutSession.findUnique({
            where: { id: entityId },
            select: { userId: true },
          });
          return session?.userId ?? null;
        }

        case 'PAYMENT': {
          const payment = await this.prisma.paymentAttempt.findUnique({
            where: { id: entityId },
            select: { userId: true },
          });
          return payment?.userId ?? null;
        }

        case 'ORDER': {
          const order = await this.prisma.order.findUnique({
            where: { id: entityId },
            select: { userId: true },
          });
          return order?.userId ?? null;
        }

        case 'RETURN': {
          const ret = await this.prisma.return.findUnique({
            where: { id: entityId },
            select: { userId: true },
          });
          return ret?.userId ?? null;
        }

        case 'REFUND': {
          const refund = await this.prisma.refund.findUnique({
            where: { id: entityId },
            select: { userId: true },
          });
          return refund?.userId ?? null;
        }

        default:
          return null;
      }
    } catch (error) {
      this.logger.warn(`Failed to resolve owner for ${entityType}:${entityId} — ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Validates whether an authenticated user is authorized to access an entity.
   *
   * Rules:
   * 1. SUPER_ADMIN: platform-wide authority.
   * 2. Direct owner (resolvedOwnerId === user.id): allowed.
   * 3. ADMIN: does NOT automatically bypass customer ownership.
   *    Allowed ONLY if explicit adminBypassPermissions are designated AND possessed.
   * 4. Any other actor: DENIED.
   */
  async isAuthorized(
    user: MinimalUser,
    entityType: EntityType,
    entityId: string,
    adminBypassPermissions?: string[],
  ): Promise<{ authorized: boolean; reason?: string }> {
    // 1. Super Admin platform-wide authority
    if (user.role === UserRole.SUPER_ADMIN) {
      return { authorized: true };
    }

    // 2. Resolve owner from database
    const ownerId = await this.resolveOwnerId(entityType, entityId);

    // If entity doesn't exist, we treat as not authorized to prevent existence probing/IDOR
    if (!ownerId) {
      return { authorized: false, reason: `Resource not found or has no associated owner` };
    }

    // 3. User owns the entity
    if (user.id === ownerId) {
      return { authorized: true };
    }

    // 4. Admin delegation check (strictly requires specific bypass permission, never automatic)
    if (user.role === UserRole.ADMIN && adminBypassPermissions && adminBypassPermissions.length > 0) {
      for (const perm of adminBypassPermissions) {
        const hasPermission = await this.permissionsService.can(user, perm);
        if (hasPermission) {
          return { authorized: true };
        }
      }
      return {
        authorized: false,
        reason: `Admin lacks required management permission (${adminBypassPermissions.join(', ')}) to access customer resource`,
      };
    }

    // 5. Default Deny
    return {
      authorized: false,
      reason: `User ${user.id} does not own ${entityType} ${entityId} and lacks administrative delegation`,
    };
  }
}
