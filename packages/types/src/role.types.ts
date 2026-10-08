/**
 * Role Types
 *
 * Defines the role hierarchy for the platform.
 *
 * Current roles:
 *   SUPER_ADMIN — Platform-level control
 *   ADMIN       — Operational management
 *   USER        — Normal application user
 *
 * Future role (NOT yet active):
 *   CUSTOMER    — Organization/customer layer (multi-tenant future feature)
 *
 * IMPORTANT: The current application is designed for direct individual users.
 * The CUSTOMER/ORGANIZATION layer is an additive future feature and must NOT
 * be depended upon in the current flow.
 */

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  USER = 'USER',
  // Future: CUSTOMER = 'CUSTOMER',
}

/**
 * Role hierarchy — higher index = more privilege.
 * Used to determine if one role has authority over another.
 */
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  [UserRole.USER]: 1,
  [UserRole.ADMIN]: 2,
  [UserRole.SUPER_ADMIN]: 3,
};

export type RoleHierarchyLevel = (typeof ROLE_HIERARCHY)[UserRole];

export interface RoleDefinition {
  id: string;
  name: UserRole;
  description: string;
  isSystem: boolean;
  permissions?: string[];
}
