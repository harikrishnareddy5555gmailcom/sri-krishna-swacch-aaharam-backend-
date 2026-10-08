import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator to require one or more specific permissions on an endpoint.
 * Evaluated by PermissionsGuard.
 *
 * Example:
 *   @RequirePermissions(Permissions.ORDERS_VIEW)
 *   @RequirePermissions('ORDERS.VIEW', 'ORDERS.UPDATE')
 */
export const RequirePermissions = (
  ...permissions: string[]
): CustomDecorator<string> => SetMetadata(PERMISSIONS_KEY, permissions);
