/**
 * Shared constants used across the platform.
 */

// ─── Currency ─────────────────────────────────────────────────────────────────

/** Default currency for the platform */
export const DEFAULT_CURRENCY = 'INR';

/** Currency display symbol */
export const CURRENCY_SYMBOL = '₹';

/** Smallest currency unit multiplier (1 INR = 100 paise) */
export const CURRENCY_UNIT_MULTIPLIER = 100;

// ─── Pagination ───────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** Maximum failed login attempts before lockout */
export const MAX_LOGIN_ATTEMPTS = 5;

/** Lockout duration in minutes */
export const LOCKOUT_DURATION_MINUTES = 15;

// ─── File Uploads (Future) ────────────────────────────────────────────────────

/** Maximum file size in bytes (5MB) */
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;

// ─── API ──────────────────────────────────────────────────────────────────────

export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

// ─── Roles (string constants matching the enum for cross-package use) ─────────

export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  USER: 'USER',
} as const;

export type RoleKey = keyof typeof ROLES;
