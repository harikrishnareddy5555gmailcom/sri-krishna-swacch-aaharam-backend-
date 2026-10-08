import type { PublicUser } from './user.types.js';

/**
 * Auth Types
 *
 * Shared authentication-related types and DTOs.
 * Used by both frontend (API calls) and backend (validation).
 */

/**
 * Credentials sent during login.
 */
export interface LoginCredentials {
  email: string;
  password: string;
}

/**
 * Data submitted during user registration.
 */
export interface RegisterCredentials {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * The response returned after a successful login.
 * The access token is short-lived (e.g., 15 minutes).
 * The refresh token is long-lived and should be stored in an httpOnly cookie.
 *
 * SECURITY NOTE:
 * - Access token: stored in memory (not localStorage)
 * - Refresh token: httpOnly cookie (not accessible by JS)
 * - Never expose JWT secrets to the frontend
 */
export interface AuthTokens {
  accessToken: string;
  expiresIn: number; // seconds
}

/**
 * The full auth response sent to the client after login/register.
 */
export interface AuthResponse {
  user: PublicUser;
  tokens: AuthTokens;
}

/**
 * JWT Payload — the data encoded inside an access token.
 * Keep minimal to reduce token size.
 */
export interface JwtPayload {
  sub: string; // user ID
  email: string;
  role: string;
  iat?: number; // issued at
  exp?: number; // expiry
}

/**
 * Phone OTP request payload.
 */
export interface PhoneOtpRequestPayload {
  phone: string;
}

/**
 * Phone OTP verification payload.
 */
export interface PhoneOtpVerifyPayload {
  phone: string;
  otp?: string;
  idToken?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Google Auth verification payload.
 */
export interface GoogleAuthPayload {
  idToken: string;
}


/**
 * Refresh token payload.
 */
export interface JwtRefreshPayload {
  sub: string; // user ID
  tokenVersion?: number; // for token rotation/revocation
  iat?: number;
  exp?: number;
}
