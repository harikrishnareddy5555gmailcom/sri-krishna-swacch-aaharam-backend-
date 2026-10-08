import type { UserRole } from './role.types.js';
import type { Permission } from './permission.types.js';

/**
 * User Types
 *
 * Core user entity for the Vishkaraa platform.
 *
 * Current model: Direct individual users.
 * Future: Users may optionally belong to a Customer/Organization,
 *         but this is additive — current users are NOT dependent on it.
 */

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
}

/**
 * The full user entity (as stored in the database / returned internally).
 * The password hash is NEVER included in this type when sent to the client.
 */
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  // Future: customerId?: string | null; — additive, non-breaking
}

/**
 * Safe public user data — safe to send to the frontend.
 * Sensitive fields (password, internal flags) are excluded.
 */
export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
}

/**
 * The authenticated user context — included in request objects after auth.
 * Contains the user's resolved permissions for authorization checks.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  permissions: Permission[];
}

/**
 * Saved Delivery Address label
 */
export enum AddressLabel {
  HOME = 'HOME',
  WORK = 'WORK',
  OTHER = 'OTHER',
}

/**
 * Saved Delivery Address entity representation
 */
export interface UserAddress {
  id: string;
  userId: string;
  recipientName: string;
  fullName?: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  landmark?: string | null;
  label: AddressLabel;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

