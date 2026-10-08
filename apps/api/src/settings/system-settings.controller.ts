import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SystemSettingsService, type SettingItem } from './system-settings.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { UserRole } from '@vishkaraa/types';
import type { PublicFeatureFlags } from '@vishkaraa/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

@Controller()
export class SystemSettingsController {
  constructor(private readonly settingsService: SystemSettingsService) {}

  /**
   * GET /api/v1/settings/public-flags
   * Publicly accessible endpoint returning customer-facing feature flags.
   */
  @Get('settings/public-flags')
  @HttpCode(HttpStatus.OK)
  async getPublicFlags(): Promise<PublicFeatureFlags> {
    return this.settingsService.getPublicFeatureFlags();
  }

  /**
   * GET /api/v1/admin/settings
   * Admin-only endpoint returning all system settings.
   */
  @Get('admin/settings')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getAllSettings(@Req() req: AuthenticatedRequest): Promise<SettingItem[]> {
    if (req.user.role !== UserRole.SUPER_ADMIN && req.user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only administrators can view system settings');
    }
    return this.settingsService.getAllSettings();
  }

  /**
   * PATCH /api/v1/admin/settings/:key
   * Super Admin only: update a specific configuration or feature flag.
   */
  @Patch('admin/settings/:key')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateSetting(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Body() body: { value: unknown; description?: string },
  ): Promise<SettingItem> {
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only SUPER_ADMIN can modify business configuration settings');
    }
    if (body.value === undefined) {
      throw new BadRequestException('A value must be provided for the setting');
    }
    return this.settingsService.updateSetting(key, body.value, req.user.email, body.description);
  }
}

