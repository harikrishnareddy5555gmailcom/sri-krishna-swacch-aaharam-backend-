import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import type { Prisma, User, UserAddress } from '@prisma/client';
import { AddressLabel } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditEntityType,
  UserRole,
  UserStatus,
} from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';
import {
  UserResponseDto,
  AdminUserDetailDto,
  PaginatedUsersDto,
  UpdateProfileDto,
  ChangePasswordDto,
  QueryUsersDto,
  AdminUpdateUserDto,
  DeactivateUserDto,
  ReactivateUserDto,
  CreateAddressDto,
  UpdateAddressDto,
  UserAddressResponseDto,
} from './dto/index.js';


/**
 * Strips passwordHash and returns a safe UserResponseDto.
 */
function toSafeUser(user: User): UserResponseDto {
  const { passwordHash: _, ...safe } = user;
  return {
    id: safe.id,
    email: safe.email,
    firstName: safe.firstName,
    lastName: safe.lastName,
    role: safe.role as unknown as UserRole,
    status: safe.status as unknown as UserStatus,
    emailVerifiedAt: safe.emailVerifiedAt,
    createdAt: safe.createdAt,
    updatedAt: safe.updatedAt,
  };
}

/**
 * Maps UserAddress database record to a clean UserAddressResponseDto.
 */
function toSafeAddress(address: UserAddress): UserAddressResponseDto {
  return {
    id: address.id,
    userId: address.userId,
    recipientName: address.recipientName,
    fullName: address.recipientName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    landmark: address.landmark,
    label: address.label,
    isDefault: address.isDefault,
    createdAt: address.createdAt,
    updatedAt: address.updatedAt,
  };
}


/**
 * Users Service — Production-grade Customer / User Management
 *
 * Single source of truth for user database operations, account lifecycle,
 * profile management, security operations, and administrative controls.
 *
 * SECURITY:
 * - Password hashes are strictly omitted from all public and administrative responses
 * - Authenticated user identity context is enforced; client-supplied userId is never trusted
 * - Hierarchy guards: ADMIN cannot deactivate or modify SUPER_ADMIN
 * - Self-lockout protection: Admins cannot deactivate their own account
 * - Last SUPER_ADMIN protection: System prohibits disabling the final active Super Admin
 * - Password changes verify current password, enforce policy, re-hash with bcrypt, and revoke active sessions
 * - Append-only audit logs record all sensitive actions with sanitized metadata
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
  ) {}

  // ===========================================================================
  // INTERNAL / AUTH-FACING METHODS
  // ===========================================================================

  /**
   * Find a user by email.
   * Returns the full user record INCLUDING passwordHash.
   * ONLY use this in AuthService.validateUser().
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
  }

  /**
   * Find a user by ID.
   * Returns the full user record INCLUDING passwordHash (for internal use).
   */
  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  /**
   * Find a user by ID without the password hash.
   * Safe for returning to controllers.
   */
  async findByIdSafe(id: string): Promise<UserResponseDto | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });
    return user ? toSafeUser(user) : null;
  }

  /**
   * Find user by ID — throws NotFoundException if not found.
   */
  async findByIdOrFail(id: string): Promise<UserResponseDto> {
    const user = await this.findByIdSafe(id);
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }

  /**
   * Create a new user.
   * The password must already be hashed before calling this method.
   */
  async create(data: {
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: data.email.toLowerCase().trim(),
        passwordHash: data.passwordHash,
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        role: 'USER',
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Legacy findAll method preserved for backwards compatibility.
   */
  async findAll(params: { page: number; pageSize: number }): Promise<{
    users: UserResponseDto[];
    total: number;
  }> {
    const skip = (params.page - 1) * params.pageSize;
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        skip,
        take: params.pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.user.count(),
    ]);

    return {
      users: users.map(toSafeUser),
      total,
    };
  }

  // ===========================================================================
  // USER PROFILE SELF-SERVICE (PHASE 17)
  // ===========================================================================

  /**
   * Retrieves the authenticated user's profile.
   */
  async getProfile(userId: string): Promise<UserResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User profile not found');
    }
    return toSafeUser(user);
  }

  /**
   * Updates permitted profile fields (firstName, lastName) for the authenticated user.
   */
  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!existing) {
      throw new NotFoundException('User profile not found');
    }

    const dataToUpdate: Prisma.UserUpdateInput = {};
    if (dto.firstName !== undefined) {
      dataToUpdate.firstName = dto.firstName.trim();
    }
    if (dto.lastName !== undefined) {
      dataToUpdate.lastName = dto.lastName.trim();
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
    });

    await this.auditService.logEvent({
      actorId: userId,
      actorRole: existing.role,
      actorEmail: existing.email,
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: userId,
      userId,
      previousValue: { firstName: existing.firstName, lastName: existing.lastName },
      newValue: { firstName: updated.firstName, lastName: updated.lastName },
      reason: 'Self-service profile update',
    });

    return toSafeUser(updated);
  }

  /**
   * Changes the authenticated user's password.
   * Verifies current password, enforces complexity, hashes with bcrypt,
   * revokes existing active sessions, and logs an audit record.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    // Verify current password
    const isCurrentValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isCurrentValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Ensure new password differs from current
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException(
        'New password must be different from current password',
      );
    }

    // Hash new password using configured salt rounds
    const saltRounds = parseInt(
      this.config.get<string>('BCRYPT_SALT_ROUNDS', '12'),
      10,
    );
    const newPasswordHash = await bcrypt.hash(dto.newPassword, saltRounds);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    // Revoke all active refresh tokens/sessions for security
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Audit log (sanitizer ensures zero credential leakage)
    await this.auditService.logEvent({
      actorId: userId,
      actorRole: user.role,
      actorEmail: user.email,
      action: AuditAction.USER_PASSWORD_CHANGED,
      entityType: AuditEntityType.USER,
      entityId: userId,
      userId,
      reason: 'Self-service password update',
    });

    return {
      success: true,
      message: 'Password changed successfully. Existing sessions have been terminated.',
    };
  }

  // ===========================================================================
  // ADMINISTRATIVE USER MANAGEMENT (PHASE 17)
  // ===========================================================================

  /**
   * Lists users with server-side pagination, search, and role/status filtering.
   * Deterministic ordering by createdAt desc, id asc.
   */
  async findAdminUsers(query: QueryUsersDto): Promise<PaginatedUsersDto> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const where: Prisma.UserWhereInput = {};

    if (query.role) {
      where.role = query.role;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      where.OR = [
        { email: { contains: term, mode: 'insensitive' } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map(toSafeUser),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  /**
   * Retrieves operational user details for administrators.
   */
  async getAdminUserDetail(targetUserId: string): Promise<AdminUserDetailDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: {
        _count: {
          select: { orders: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    const safe = toSafeUser(user);
    return {
      ...safe,
      orderCount: user._count.orders,
    };
  }

  /**
   * Updates allowed operational profile fields for a user.
   * Gated: ADMIN cannot modify SUPER_ADMIN accounts.
   */
  async adminUpdateUser(
    actor: MinimalUser,
    targetUserId: string,
    dto: AdminUpdateUserDto,
  ): Promise<UserResponseDto> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    // Role hierarchy protection
    if (
      actor.role === UserRole.ADMIN &&
      (target.role as unknown as UserRole) === UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        'Administrators cannot modify Super Admin profiles',
      );
    }

    const dataToUpdate: Prisma.UserUpdateInput = {};
    if (dto.firstName !== undefined) {
      dataToUpdate.firstName = dto.firstName.trim();
    }
    if (dto.lastName !== undefined) {
      dataToUpdate.lastName = dto.lastName.trim();
    }
    if (dto.role !== undefined) {
      if (actor.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          'Only Super Admins can modify user roles',
        );
      }
      dataToUpdate.role = dto.role;
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: dataToUpdate,
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: targetUserId,
      userId: targetUserId,
      previousValue: { firstName: target.firstName, lastName: target.lastName },
      newValue: { firstName: updated.firstName, lastName: updated.lastName },
      reason: 'Administrative profile update',
    });

    return toSafeUser(updated);
  }

  /**
   * Safely deactivates/suspends a user account.
   * Enforces self-lockout prevention, SuperAdmin hierarchy protection,
   * last active SuperAdmin guarantee, session revocation, and audit logging.
   */
  async deactivateUser(
    actor: MinimalUser,
    targetUserId: string,
    dto: DeactivateUserDto,
  ): Promise<UserResponseDto> {
    // 1. Self-lockout protection
    if (actor.id === targetUserId) {
      throw new ForbiddenException(
        'Self-deactivation is prohibited. You cannot deactivate your own account.',
      );
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    const targetRole = target.role as unknown as UserRole;

    // 2. Hierarchy protection: ADMIN cannot deactivate SUPER_ADMIN
    if (actor.role === UserRole.ADMIN && targetRole === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Administrators cannot deactivate Super Admin accounts',
      );
    }

    // 3. Last active SUPER_ADMIN protection
    if (targetRole === UserRole.SUPER_ADMIN) {
      const activeSuperAdmins = await this.prisma.user.count({
        where: {
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
        },
      });
      if (activeSuperAdmins <= 1 && target.status === 'ACTIVE') {
        throw new ForbiddenException(
          'Cannot deactivate the last remaining active Super Admin account',
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: 'SUSPENDED' },
    });

    // 4. Terminate all active sessions immediately
    await this.prisma.refreshToken.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // 5. Append-only audit record
    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.USER_SUSPENDED,
      entityType: AuditEntityType.USER,
      entityId: targetUserId,
      userId: targetUserId,
      previousValue: { status: target.status },
      newValue: { status: updated.status },
      reason: dto.reason,
    });

    return toSafeUser(updated);
  }

  /**
   * Safely reactivates a suspended/inactive user account.
   */
  async reactivateUser(
    actor: MinimalUser,
    targetUserId: string,
    dto: ReactivateUserDto,
  ): Promise<UserResponseDto> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    const targetRole = target.role as unknown as UserRole;

    // Hierarchy protection: ADMIN cannot modify SUPER_ADMIN
    if (actor.role === UserRole.ADMIN && targetRole === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Administrators cannot modify Super Admin accounts',
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: 'ACTIVE' },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.USER_ACTIVATED,
      entityType: AuditEntityType.USER,
      entityId: targetUserId,
      userId: targetUserId,
      previousValue: { status: target.status },
      newValue: { status: updated.status },
      reason: dto.reason || 'Reactivated by administrator',
    });

    return toSafeUser(updated);
  }

  // ===========================================================================
  // SAVED DELIVERY ADDRESSES (PHASE 20D.8.2A)
  // ===========================================================================

  /**
   * Retrieves all saved delivery addresses for the authenticated user.
   * Sorted with the default address first, followed by most recently created.
   */
  async getUserAddresses(userId: string): Promise<UserAddressResponseDto[]> {
    const addresses = await this.prisma.userAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return addresses.map(toSafeAddress);
  }

  /**
   * Creates a saved delivery address for the authenticated user.
   *
   * Business Rules:
   * - If this is the user's first address, it is automatically marked as default.
   * - If marked as default, any previous default address for this user is unset atomically.
   * - Scoped exclusively to the authenticated user ID.
   * - Audit log records non-PII metadata only.
   */
  async createUserAddress(
    userId: string,
    dto: CreateAddressDto,
  ): Promise<UserAddressResponseDto> {
    const recipientName = (dto.recipientName || dto.fullName)?.trim();
    if (!recipientName) {
      throw new BadRequestException('Recipient name is required');
    }

    const phone = (dto.phone || dto.phoneNumber)?.trim();
    if (!phone) {
      throw new BadRequestException('Phone number is required');
    }

    const line1 = (dto.line1 || dto.addressLine1)?.trim();
    if (!line1) {
      throw new BadRequestException('Address line 1 is required');
    }

    const line2 = (dto.line2 || dto.addressLine2)?.trim() || null;
    const city = dto.city.trim();
    const state = dto.state.trim();
    const postalCode = dto.postalCode.trim();
    const country = (dto.country?.trim() || 'IN').toUpperCase();
    const landmark = dto.landmark?.trim() || null;
    const label = dto.label || AddressLabel.HOME;

    const result = await this.prisma.$transaction(async (tx) => {
      const count = await tx.userAddress.count({ where: { userId } });
      const shouldBeDefault = count === 0 || dto.isDefault === true;

      if (shouldBeDefault) {
        await tx.userAddress.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.userAddress.create({
        data: {
          userId,
          recipientName,
          phone,
          line1,
          line2,
          city,
          state,
          postalCode,
          country,
          landmark,
          label,
          isDefault: shouldBeDefault,
        },
      });
    });

    await this.auditService.logEvent({
      actorId: userId,
      actorRole: 'USER',
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: userId,
      userId,
      newValue: {
        addressId: result.id,
        isDefault: result.isDefault,
        label: result.label,
        city: result.city,
        state: result.state,
        postalCode: result.postalCode,
      },
      reason: 'Created saved delivery address',
    });

    return toSafeAddress(result);
  }

  /**
   * Updates an owned saved delivery address.
   *
   * Business Rules:
   * - Throws NotFoundException if address doesn't exist or is not owned by requester.
   * - If isDefault is set to true, existing default is atomically unset.
   * - If isDefault is set to false on a default address, another address is promoted if available.
   * - Audit log records non-PII metadata only.
   */
  async updateUserAddress(
    userId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ): Promise<UserAddressResponseDto> {
    const existing = await this.prisma.userAddress.findFirst({
      where: { id: addressId, userId },
    });
    if (!existing) {
      throw new NotFoundException('Address not found');
    }

    const dataToUpdate: Prisma.UserAddressUpdateInput = {};

    const rawName = dto.recipientName !== undefined ? dto.recipientName : dto.fullName;
    if (rawName !== undefined) {
      const trimmed = rawName.trim();
      if (!trimmed) {
        throw new BadRequestException('Recipient name must not be empty');
      }
      dataToUpdate.recipientName = trimmed;
    }

    const rawPhone = dto.phone !== undefined ? dto.phone : dto.phoneNumber;
    if (rawPhone !== undefined) {
      const trimmed = rawPhone.trim();
      if (!trimmed) {
        throw new BadRequestException('Phone number must not be empty');
      }
      dataToUpdate.phone = trimmed;
    }

    const rawLine1 = dto.line1 !== undefined ? dto.line1 : dto.addressLine1;
    if (rawLine1 !== undefined) {
      const trimmed = rawLine1.trim();
      if (!trimmed) {
        throw new BadRequestException('Address line 1 must not be empty');
      }
      dataToUpdate.line1 = trimmed;
    }

    const rawLine2 = dto.line2 !== undefined ? dto.line2 : dto.addressLine2;
    if (rawLine2 !== undefined) {
      dataToUpdate.line2 = rawLine2 ? rawLine2.trim() : null;
    }

    if (dto.city !== undefined) {
      dataToUpdate.city = dto.city.trim();
    }
    if (dto.state !== undefined) {
      dataToUpdate.state = dto.state.trim();
    }
    if (dto.postalCode !== undefined) {
      dataToUpdate.postalCode = dto.postalCode.trim();
    }
    if (dto.country !== undefined) {
      dataToUpdate.country = dto.country.trim().toUpperCase();
    }
    if (dto.landmark !== undefined) {
      dataToUpdate.landmark = dto.landmark ? dto.landmark.trim() : null;
    }
    if (dto.label !== undefined) {
      dataToUpdate.label = dto.label;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.userAddress.updateMany({
          where: { userId, isDefault: true, id: { not: addressId } },
          data: { isDefault: false },
        });
        dataToUpdate.isDefault = true;
      } else if (dto.isDefault === false && existing.isDefault) {
        dataToUpdate.isDefault = false;
        const otherAddress = await tx.userAddress.findFirst({
          where: { userId, id: { not: addressId } },
          orderBy: { createdAt: 'desc' },
        });
        if (otherAddress) {
          await tx.userAddress.update({
            where: { id: otherAddress.id },
            data: { isDefault: true },
          });
        }
      }

      return tx.userAddress.update({
        where: { id: addressId },
        data: dataToUpdate,
      });
    });

    await this.auditService.logEvent({
      actorId: userId,
      actorRole: 'USER',
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: userId,
      userId,
      newValue: {
        addressId: result.id,
        isDefault: result.isDefault,
        label: result.label,
        city: result.city,
        state: result.state,
        postalCode: result.postalCode,
      },
      reason: 'Updated saved delivery address',
    });

    return toSafeAddress(result);
  }

  /**
   * Deletes an owned saved delivery address.
   *
   * Business Rules:
   * - Throws NotFoundException if address doesn't exist or is not owned by requester.
   * - If the deleted address was default, automatically designates another address as default
   *   if one exists; if no address remains, leaves no default.
   */
  async deleteUserAddress(
    userId: string,
    addressId: string,
  ): Promise<{ success: boolean; message: string }> {
    const existing = await this.prisma.userAddress.findFirst({
      where: { id: addressId, userId },
    });
    if (!existing) {
      throw new NotFoundException('Address not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userAddress.delete({
        where: { id: addressId },
      });

      if (existing.isDefault) {
        const nextAddress = await tx.userAddress.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        });
        if (nextAddress) {
          await tx.userAddress.update({
            where: { id: nextAddress.id },
            data: { isDefault: true },
          });
        }
      }
    });

    await this.auditService.logEvent({
      actorId: userId,
      actorRole: 'USER',
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: userId,
      userId,
      newValue: { addressId, deleted: true },
      reason: 'Deleted saved delivery address',
    });

    return { success: true, message: 'Address deleted successfully' };
  }

  /**
   * Sets an owned address as the default delivery address.
   * Atomically unsets any previous default address.
   */
  async setDefaultUserAddress(
    userId: string,
    addressId: string,
  ): Promise<UserAddressResponseDto> {
    const existing = await this.prisma.userAddress.findFirst({
      where: { id: addressId, userId },
    });
    if (!existing) {
      throw new NotFoundException('Address not found');
    }

    if (existing.isDefault) {
      return toSafeAddress(existing);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.userAddress.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });

      return tx.userAddress.update({
        where: { id: addressId },
        data: { isDefault: true },
      });
    });

    await this.auditService.logEvent({
      actorId: userId,
      actorRole: 'USER',
      action: AuditAction.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: userId,
      userId,
      newValue: { addressId, isDefault: true },
      reason: 'Set saved delivery address as default',
    });

    return toSafeAddress(updated);
  }
}

