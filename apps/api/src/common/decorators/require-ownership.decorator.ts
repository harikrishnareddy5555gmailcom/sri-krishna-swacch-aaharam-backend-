import { SetMetadata } from '@nestjs/common';
import type { CustomDecorator } from '@nestjs/common';
import type { OwnershipOptions } from '../guards/resource-owner.guard.js';
import { RESOURCE_OWNER_KEY } from '../guards/resource-owner.guard.js';

/**
 * Decorator to enforce resource ownership (IDOR protection).
 *
 * Supports both direct user identity params and entity-level database ownership resolution.
 *
 * @example
 * // Direct user parameter:
 * @Get('users/:id')
 * @UseGuards(JwtAuthGuard, ResourceOwnerGuard)
 * @RequireOwnership({ paramKey: 'id', adminBypassPermissions: ['USERS.VIEW'] })
 * getUser(@Param('id') id: string) { ... }
 *
 * // Entity-level database ownership resolution:
 * @Get('orders/:id')
 * @UseGuards(JwtAuthGuard, ResourceOwnerGuard)
 * @RequireOwnership({ paramKey: 'id', entityType: 'ORDER', adminBypassPermissions: ['ORDERS.VIEW'] })
 * getOrder(@Param('id') id: string) { ... }
 */
export const RequireOwnership = (
  options: OwnershipOptions = {},
): CustomDecorator<string> => SetMetadata(RESOURCE_OWNER_KEY, options);
