import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Req,
  Version,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  type ApiResponse,
  type PermissionDefinition,
  type UserEffectivePermissions,
  PermissionEffect,
  Permissions,
} from '@vishkaraa/types';
import { PermissionsService, type MinimalUser } from './permissions.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';

interface RequestWithUser {
  user: MinimalUser;
}

export interface GrantPermissionBody {
  targetUserId: string;
  permissionKey: string;
  effect?: PermissionEffect;
  reason?: string;
}

export interface RevokePermissionBody {
  targetUserId: string;
  permissionKey: string;
  reason?: string;
}

@ApiTags('permissions')
@Controller()
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get('permissions')
  @Version('1')
  @ApiOperation({ summary: 'List all system permissions' })
  async getAllPermissions(): Promise<ApiResponse<PermissionDefinition[]>> {
    const data = await this.permissionsService.getAllPermissions();
    return {
      success: true,
      data,
      message: 'System permissions retrieved',
    };
  }

  @Get('me/permissions')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user effective permissions' })
  async getMyPermissions(
    @Req() req: RequestWithUser,
  ): Promise<ApiResponse<UserEffectivePermissions>> {
    const data = await this.permissionsService.getEffectivePermissions(
      req.user,
    );
    return {
      success: true,
      data,
      message: 'Effective permissions evaluated',
    };
  }

  @Get('admin/permissions')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.PERMISSIONS_VIEW)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin inspection of system permissions' })
  async getAdminPermissions(): Promise<ApiResponse<PermissionDefinition[]>> {
    const data = await this.permissionsService.getAllPermissions();
    return {
      success: true,
      data,
      message: 'Admin permissions list retrieved',
    };
  }

  @Get('admin/users/:userId/permissions')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.PERMISSIONS_VIEW)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get target user effective permissions and overrides' })
  async getTargetUserPermissions(
    @Param('userId') userId: string,
  ): Promise<
    ApiResponse<{
      userId: string;
      email: string;
      firstName: string;
      lastName: string;
      role: any;
      allowed: string[];
      denied: string[];
      isSuperAdmin: boolean;
      overrides: Array<{ permissionKey: string; effect: PermissionEffect }>;
    }>
  > {
    const data = await this.permissionsService.getTargetUserPermissions(userId);
    return {
      success: true,
      data,
      message: 'Target user permissions retrieved successfully',
    };
  }

  @Post('admin/permissions/grant')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.PERMISSIONS_MANAGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Grant or explicitly deny a permission to a user' })
  async grantPermission(
    @Req() req: RequestWithUser,
    @Body() body: GrantPermissionBody,
  ): Promise<
    ApiResponse<{
      targetUserId: string;
      permissionKey: string;
      effect: PermissionEffect;
    }>
  > {
    const effect = body.effect ?? PermissionEffect.ALLOW;
    await this.permissionsService.grantPermission(
      req.user,
      body.targetUserId,
      body.permissionKey,
      effect,
      body.reason,
    );

    return {
      success: true,
      data: {
        targetUserId: body.targetUserId,
        permissionKey: body.permissionKey,
        effect,
      },
      message: `Permission ${body.permissionKey} ${effect === PermissionEffect.ALLOW ? 'granted' : 'denied'} successfully`,
    };
  }

  @Post('admin/permissions/revoke')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.PERMISSIONS_MANAGE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke direct permission grant/denial from a user',
  })
  async revokePermission(
    @Req() req: RequestWithUser,
    @Body() body: RevokePermissionBody,
  ): Promise<ApiResponse<{ targetUserId: string; permissionKey: string }>> {
    await this.permissionsService.revokePermission(
      req.user,
      body.targetUserId,
      body.permissionKey,
      body.reason,
    );

    return {
      success: true,
      data: {
        targetUserId: body.targetUserId,
        permissionKey: body.permissionKey,
      },
      message: `Permission ${body.permissionKey} revoked successfully`,
    };
  }
}
