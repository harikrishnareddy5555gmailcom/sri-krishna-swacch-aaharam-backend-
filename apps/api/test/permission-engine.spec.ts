import { describe, it, expect } from 'vitest';
import { UserRole, Permissions, PermissionEffect } from '@vishkaraa/types';
import {
  evaluateEffectivePermissions,
  canPerform,
  isPermissionAssignableToAdmin,
} from '@vishkaraa/shared';

describe('Hierarchical Permission Engine', () => {
  it('SUPER_ADMIN is allowed all system permissions', () => {
    const effective = evaluateEffectivePermissions({
      userId: 'usr-super',
      role: UserRole.SUPER_ADMIN,
    });

    expect(effective.isSuperAdmin).toBe(true);
    expect(canPerform(effective.allowed, Permissions.ORDERS_VIEW)).toBe(true);
    expect(canPerform(effective.allowed, Permissions.REFUNDS_APPROVE)).toBe(
      true,
    );
    expect(canPerform(effective.allowed, Permissions.PERMISSIONS_MANAGE)).toBe(
      true,
    );
    expect(canPerform(effective.allowed, Permissions.FEATURES_MANAGE)).toBe(
      true,
    );
  });

  it('ADMIN is allowed baseline actions and denied ungranted high-privilege actions', () => {
    const effective = evaluateEffectivePermissions({
      userId: 'usr-admin',
      role: UserRole.ADMIN,
    });

    // Allowed baseline
    expect(canPerform(effective.allowed, Permissions.ORDERS_VIEW)).toBe(true);
    expect(canPerform(effective.allowed, Permissions.ORDERS_UPDATE)).toBe(true);
    expect(canPerform(effective.allowed, Permissions.PRODUCTS_VIEW)).toBe(true);
    expect(canPerform(effective.allowed, Permissions.RETURNS_APPROVE)).toBe(
      true,
    );

    // Denied by default (Super Admin boundary or requiring explicit grant)
    expect(canPerform(effective.allowed, Permissions.REFUNDS_APPROVE)).toBe(
      false,
    );
    expect(canPerform(effective.allowed, Permissions.PERMISSIONS_MANAGE)).toBe(
      false,
    );
    expect(canPerform(effective.allowed, Permissions.FEATURES_MANAGE)).toBe(
      false,
    );
    expect(canPerform(effective.allowed, Permissions.ROLES_MANAGE)).toBe(false);
  });

  it('USER is allowed standard consumer actions and denied administrative actions', () => {
    const effective = evaluateEffectivePermissions({
      userId: 'usr-user',
      role: UserRole.USER,
    });

    // Allowed user actions
    expect(canPerform(effective.allowed, Permissions.PRODUCTS_VIEW)).toBe(true);
    expect(canPerform(effective.allowed, Permissions.CART_VIEW)).toBe(true);
    expect(canPerform(effective.allowed, Permissions.ORDERS_CREATE)).toBe(true);
    expect(canPerform(effective.allowed, Permissions.RETURNS_CREATE)).toBe(
      true,
    );

    // Denied administrative actions
    expect(canPerform(effective.allowed, Permissions.ORDERS_UPDATE)).toBe(
      false,
    );
    expect(canPerform(effective.allowed, Permissions.RETURNS_APPROVE)).toBe(
      false,
    );
    expect(canPerform(effective.allowed, Permissions.USERS_VIEW)).toBe(false);
    expect(canPerform(effective.allowed, Permissions.PERMISSIONS_VIEW)).toBe(
      false,
    );
  });

  it('unknown permission is strictly denied', () => {
    const effective = evaluateEffectivePermissions({
      userId: 'usr-user',
      role: UserRole.USER,
    });

    expect(canPerform(effective.allowed, 'NON_EXISTENT.ACTION')).toBe(false);
  });

  it('explicit direct user ALLOW grants a capability to an admin or user', () => {
    // Admin initially does NOT have REFUNDS.APPROVE
    const effectiveWithGrant = evaluateEffectivePermissions({
      userId: 'usr-admin',
      role: UserRole.ADMIN,
      userPermissions: [
        {
          id: 'grant-1',
          userId: 'usr-admin',
          permissionKey: Permissions.REFUNDS_APPROVE,
          effect: PermissionEffect.ALLOW,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    expect(
      canPerform(effectiveWithGrant.allowed, Permissions.REFUNDS_APPROVE),
    ).toBe(true);
  });

  it('explicit direct user DENY overrides role baseline ALLOW', () => {
    // Admin normally has ORDERS.UPDATE, but user has explicit DENY
    const effectiveWithDenial = evaluateEffectivePermissions({
      userId: 'usr-admin',
      role: UserRole.ADMIN,
      userPermissions: [
        {
          id: 'deny-1',
          userId: 'usr-admin',
          permissionKey: Permissions.ORDERS_UPDATE,
          effect: PermissionEffect.DENY,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    expect(
      canPerform(effectiveWithDenial.allowed, Permissions.ORDERS_UPDATE),
    ).toBe(false);
    expect(effectiveWithDenial.denied).toContain(Permissions.ORDERS_UPDATE);
  });

  it('enforces delegation boundary metadata (isPermissionAssignableToAdmin)', () => {
    // Delegable to Admin
    expect(isPermissionAssignableToAdmin(Permissions.ORDERS_VIEW)).toBe(true);
    expect(isPermissionAssignableToAdmin(Permissions.REFUNDS_APPROVE)).toBe(
      true,
    );

    // Restricted exclusively to SUPER_ADMIN
    expect(isPermissionAssignableToAdmin(Permissions.PERMISSIONS_MANAGE)).toBe(
      false,
    );
    expect(isPermissionAssignableToAdmin(Permissions.FEATURES_MANAGE)).toBe(
      false,
    );
    expect(isPermissionAssignableToAdmin(Permissions.ROLES_MANAGE)).toBe(false);
    expect(isPermissionAssignableToAdmin(Permissions.ADMINS_MANAGE)).toBe(
      false,
    );
  });
});
