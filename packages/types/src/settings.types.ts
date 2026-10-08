/**
 * System Settings & Feature Flag Types
 */

export interface SystemSettingItem {
  key: string;
  value: unknown;
  description?: string | null;
  updatedBy?: string | null;
  updatedAt: string;
}

export interface PublicFeatureFlags {
  enablePhoneOtp: boolean;
  enableGoogleAuth: boolean;
  enableCoupons: boolean;
  enableReturns: boolean;
}
