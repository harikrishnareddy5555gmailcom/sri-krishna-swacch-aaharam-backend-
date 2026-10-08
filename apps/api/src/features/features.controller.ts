import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseGuards,
  Req,
  Version,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  type ApiResponse,
  type FeatureDefinition,
  type UserFeatureAccess,
  FeatureKey,
  FeatureStatus,
  Permissions,
} from '@vishkaraa/types';
import { FeaturesService } from './features.service.js';
import type { MinimalUser } from '../permissions/permissions.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';

interface RequestWithUser {
  user: MinimalUser;
}

export interface UpdateFeatureStatusBody {
  status: FeatureStatus;
  reason?: string;
}

@ApiTags('features')
@Controller()
export class FeaturesController {
  constructor(private readonly featuresService: FeaturesService) {}

  @Get('features')
  @Version('1')
  @ApiOperation({ summary: 'List all platform features and metadata' })
  async getAllFeatures(): Promise<ApiResponse<FeatureDefinition[]>> {
    const data = await this.featuresService.getAllFeatures();
    return {
      success: true,
      data,
      message: 'Features retrieved',
    };
  }

  @Get('me/features')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user accessible and enabled features' })
  async getMyFeatures(
    @Req() req: RequestWithUser,
  ): Promise<ApiResponse<UserFeatureAccess[]>> {
    const data = await this.featuresService.getEffectiveFeaturesForUser(
      req.user,
    );
    return {
      success: true,
      data,
      message: 'User feature access evaluated',
    };
  }

  @Get('admin/features')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.FEATURES_VIEW)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin feature registry inspection' })
  async getAdminFeatures(): Promise<ApiResponse<FeatureDefinition[]>> {
    const data = await this.featuresService.getAllFeatures();
    return {
      success: true,
      data,
      message: 'Admin feature registry retrieved',
    };
  }

  @Patch('admin/features/:key/status')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.FEATURES_MANAGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update feature status with dependency validation' })
  async updateStatus(
    @Req() req: RequestWithUser,
    @Param('key') key: FeatureKey,
    @Body() body: UpdateFeatureStatusBody,
  ): Promise<ApiResponse<FeatureDefinition>> {
    const data = await this.featuresService.updateFeatureStatus(
      key,
      body.status,
      req.user,
      body.reason,
    );

    return {
      success: true,
      data,
      message: `Feature ${key} status updated to ${body.status}`,
    };
  }
}
