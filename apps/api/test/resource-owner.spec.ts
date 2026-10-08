import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { ResourceOwnerGuard, RESOURCE_OWNER_KEY } from '../src/common/guards/resource-owner.guard.js';
import { UserRole } from '@vishkaraa/types';

describe('ResourceOwnerGuard (IDOR Prevention)', () => {
  let guard: ResourceOwnerGuard;
  let mockReflector: any;
  let mockPermissionsService: any;

  beforeEach(() => {
    mockReflector = {
      getAllAndOverride: vi.fn(),
    };
    mockPermissionsService = {
      can: vi.fn(),
    };
    guard = new ResourceOwnerGuard(mockReflector, mockPermissionsService);
  });

  function createMockContext(user: any, params: any): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          user,
          params,
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('allows access when user requests their own resource', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({ paramKey: 'userId' });

    const user = { id: 'usr-101', role: UserRole.USER };
    const context = createMockContext(user, { userId: 'usr-101' });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('denies access (throws ForbiddenException) when user requests another user resource', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({ paramKey: 'userId' });

    const user = { id: 'attacker-1', role: UserRole.USER };
    const context = createMockContext(user, { userId: 'victim-999' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('allows SUPER_ADMIN to access any user resource regardless of ownership', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({ paramKey: 'userId' });

    const superAdmin = { id: 'super-1', role: UserRole.SUPER_ADMIN };
    const context = createMockContext(superAdmin, { userId: 'any-user-id' });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('allows ADMIN with specific bypass permission to access resource', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({
      paramKey: 'userId',
      adminBypassPermissions: ['USERS.VIEW'],
    });
    mockPermissionsService.can.mockResolvedValue(true);

    const admin = { id: 'admin-1', role: UserRole.ADMIN };
    const context = createMockContext(admin, { userId: 'target-user' });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('denies ADMIN without bypass permission from accessing another user resource', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({
      paramKey: 'userId',
      adminBypassPermissions: ['USERS.VIEW'],
    });
    mockPermissionsService.can.mockResolvedValue(false);

    const admin = { id: 'admin-1', role: UserRole.ADMIN };
    const context = createMockContext(admin, { userId: 'target-user' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});
