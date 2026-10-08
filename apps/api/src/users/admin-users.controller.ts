import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Version,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import { UsersService } from './users.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequireFeatures } from '../auth/decorators/features.decorator.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { FeatureKey, Permissions } from '@vishkaraa/types';
import type { ApiResponse } from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';
import {
  QueryUsersDto,
  AdminUpdateUserDto,
  DeactivateUserDto,
  ReactivateUserDto,
  PaginatedUsersDto,
  AdminUserDetailDto,
  UserResponseDto,
} from './dto/index.js';

interface AuthenticatedRequest extends Request {
  user: MinimalUser;
}

@ApiTags('Admin User Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeaturesGuard, PermissionsGuard)
@RequireFeatures(FeatureKey.USER_MANAGEMENT)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Version('1')
  @RequirePermissions(Permissions.USERS_VIEW)
  @ApiOperation({ summary: 'List users with pagination, search, and filtering' })
  async listUsers(
    @Query() query: QueryUsersDto,
  ): Promise<ApiResponse<PaginatedUsersDto>> {
    const result = await this.usersService.findAdminUsers(query);
    return {
      success: true,
      data: result,
      message: 'Users retrieved successfully',
    };
  }

  @Get(':id')
  @Version('1')
  @RequirePermissions(Permissions.USERS_VIEW)
  @ApiOperation({ summary: 'Get administrative user details by ID' })
  async getUserDetail(
    @Param('id') id: string,
  ): Promise<ApiResponse<AdminUserDetailDto>> {
    const user = await this.usersService.getAdminUserDetail(id);
    return {
      success: true,
      data: user,
      message: 'User details retrieved',
    };
  }

  @Patch(':id')
  @Version('1')
  @RequirePermissions(Permissions.USERS_UPDATE)
  @ApiOperation({ summary: 'Update operational user profile fields' })
  async updateUser(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
  ): Promise<ApiResponse<UserResponseDto>> {
    const updated = await this.usersService.adminUpdateUser(req.user, id, dto);
    return {
      success: true,
      data: updated,
      message: 'User profile updated successfully',
    };
  }

  @Post(':id/deactivate')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permissions.USERS_UPDATE)
  @ApiOperation({ summary: 'Deactivate / suspend a user account' })
  async deactivateUser(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: DeactivateUserDto,
  ): Promise<ApiResponse<UserResponseDto>> {
    const deactivated = await this.usersService.deactivateUser(
      req.user,
      id,
      dto,
    );
    return {
      success: true,
      data: deactivated,
      message: 'User account has been deactivated and active sessions revoked',
    };
  }

  @Post(':id/reactivate')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permissions.USERS_UPDATE)
  @ApiOperation({ summary: 'Reactivate a user account' })
  async reactivateUser(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ReactivateUserDto,
  ): Promise<ApiResponse<UserResponseDto>> {
    const reactivated = await this.usersService.reactivateUser(
      req.user,
      id,
      dto,
    );
    return {
      success: true,
      data: reactivated,
      message: 'User account has been reactivated',
    };
  }
}
