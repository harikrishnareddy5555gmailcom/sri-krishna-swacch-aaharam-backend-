import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

export interface SettingItem {
  key: string;
  value: unknown;
  description?: string | null;
  updatedBy?: string | null;
  updatedAt: string;
}

const DEFAULT_SETTINGS: Record<string, { value: unknown; description: string }> = {
  // Feature Flags (Master Super Admin Controls)
  'features.auth.phone_otp': {
    value: true,
    description: 'Enables mobile phone number + 6-digit OTP authentication & registration on customer portal.',
  },
  'features.auth.google': {
    value: true,
    description: 'Enables Google 1-Tap & OAuth Social Sign-In for customers.',
  },
  'features.ecommerce.coupons': {
    value: true,
    description: 'Enables promotional discount codes & coupon application in cart and checkout.',
  },
  'features.ecommerce.returns': {
    value: true,
    description: 'Enables customer-facing self-service return & replacement claim desk.',
  },

  // Operational Settings
  'order.cancellation.require_approval': {
    value: true,
    description: 'Requires administrator approval before order cancellation is completed and inventory restored.',
  },
  'order.cancellation.allowed_before_packed': {
    value: true,
    description: 'Permits customer cancellation requests only before order is PACKED or SHIPPED.',
  },
  'order.cancellation.time_window_hours': {
    value: 2,
    description: 'Authoritative cancellation request time window in hours from order placement.',
  },
  'order.returns.policy': {
    value: 'MANUAL_REVIEW_48H',
    description: 'Return & damage policy: Customer submits damage photo and reason within 48h for manual admin review.',
  },
  'order.returns.require_evidence': {
    value: true,
    description: 'Requires photograph or supporting damage evidence for return/replacement requests.',
  },
  'order.returns.time_limit_hours': {
    value: 48,
    description: 'Eligible damage/return request window in hours following marked delivery.',
  },
};

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getPublicFeatureFlags(): Promise<{
    enablePhoneOtp: boolean;
    enableGoogleAuth: boolean;
    enableCoupons: boolean;
    enableReturns: boolean;
  }> {
    const [phoneOtp, googleAuth, coupons, returns] = await Promise.all([
      this.getSetting<boolean>('features.auth.phone_otp', true),
      this.getSetting<boolean>('features.auth.google', true),
      this.getSetting<boolean>('features.ecommerce.coupons', true),
      this.getSetting<boolean>('features.ecommerce.returns', true),
    ]);
    return {
      enablePhoneOtp: Boolean(phoneOtp),
      enableGoogleAuth: Boolean(googleAuth),
      enableCoupons: Boolean(coupons),
      enableReturns: Boolean(returns),
    };
  }

  async getAllSettings(): Promise<SettingItem[]> {
    let dbSettings: Array<{ key: string; value: unknown; description: string | null; updatedBy: string | null; updatedAt: Date }> = [];
    try {
      dbSettings = await this.prisma.systemSetting.findMany();
    } catch (err) {
      this.logger.warn(`Could not fetch system settings from database: ${(err as Error).message}. Using default settings.`);
    }
    const dbMap = new Map(dbSettings.map((s) => [s.key, s]));

    const result: SettingItem[] = [];

    // Combine defaults and db-stored overrides
    for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
      const stored = dbMap.get(key);
      if (stored) {
        result.push({
          key: stored.key,
          value: stored.value,
          description: stored.description || def.description,
          updatedBy: stored.updatedBy,
          updatedAt: stored.updatedAt.toISOString(),
        });
        dbMap.delete(key);
      } else {
        result.push({
          key,
          value: def.value,
          description: def.description,
          updatedBy: 'SYSTEM_DEFAULT',
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // Add any custom settings created in DB
    for (const stored of dbMap.values()) {
      result.push({
        key: stored.key,
        value: stored.value,
        description: stored.description,
        updatedBy: stored.updatedBy,
        updatedAt: stored.updatedAt.toISOString(),
      });
    }

    return result;
  }

  async getSetting<T>(key: string, fallback?: T): Promise<T> {
    try {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key },
      });
      if (setting) {
        return setting.value as T;
      }
    } catch (err) {
      this.logger.warn(`Failed reading system setting '${key}' from DB: ${(err as Error).message}. Falling back to default.`);
    }
    const def = DEFAULT_SETTINGS[key];
    if (def) {
      return def.value as T;
    }
    return fallback as T;
  }

  async updateSetting(
    key: string,
    value: unknown,
    actorEmail: string,
    description?: string,
  ): Promise<SettingItem> {
    const updated = await this.prisma.systemSetting.upsert({
      where: { key },
      create: {
        key,
        value: value as any,
        description: description || DEFAULT_SETTINGS[key]?.description,
        updatedBy: actorEmail,
      },
      update: {
        value: value as any,
        ...(description ? { description } : {}),
        updatedBy: actorEmail,
      },
    });

    this.logger.log(`[SETTINGS] Setting '${key}' updated by ${actorEmail}: ${JSON.stringify(value)}`);

    return {
      key: updated.key,
      value: updated.value,
      description: updated.description,
      updatedBy: updated.updatedBy,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}
