import {
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  Version,
  Query,
  ForbiddenException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { UsersService } from './users.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequireFeatures } from '../auth/decorators/features.decorator.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { FeatureKey, Permissions, UserRole } from '@vishkaraa/types';
import type { ApiResponse } from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';
import {
  UpdateProfileDto,
  ChangePasswordDto,
  UserResponseDto,
  QueryUsersDto,
  PaginatedUsersDto,
  CreateAddressDto,
  UpdateAddressDto,
  UserAddressResponseDto,
} from './dto/index.js';

interface AuthenticatedRequest extends Request {
  user: MinimalUser;
}

/**
 * Users Controller — User Self-Service & IDOR-Secured Profile Operations
 *
 * Provides authenticated operations for users to view/manage their own identity.
 * Strictly prevents horizontal privilege escalation (IDOR) and protects sensitive fields.
 */
@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ===========================================================================
  // OWN PROFILE MANAGEMENT (PHASE 17)
  // ===========================================================================

  @Get('me')
  @Version('1')
  @ApiOperation({ summary: 'Get authenticated user profile' })
  async getMyProfile(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<UserResponseDto>> {
    const profile = await this.usersService.getProfile(req.user.id);
    return {
      success: true,
      data: profile,
      message: 'Profile retrieved',
    };
  }

  @Get('profile')
  @Version('1')
  @ApiOperation({ summary: 'Get authenticated user profile (alias)' })
  async getProfileAlias(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<UserResponseDto>> {
    return this.getMyProfile(req);
  }

  @Patch('me')
  @Version('1')
  @ApiOperation({ summary: 'Update permitted fields of own profile' })
  async updateMyProfile(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ): Promise<ApiResponse<UserResponseDto>> {
    const updated = await this.usersService.updateProfile(req.user.id, dto);
    return {
      success: true,
      data: updated,
      message: 'Profile updated successfully',
    };
  }

  @Patch('profile')
  @Version('1')
  @ApiOperation({ summary: 'Update permitted fields of own profile (alias)' })
  async updateProfileAlias(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ): Promise<ApiResponse<UserResponseDto>> {
    return this.updateMyProfile(req, dto);
  }

  @Post('change-password')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Change own account password' })
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<ApiResponse<{ message: string }>> {
    const result = await this.usersService.changePassword(req.user.id, dto);
    return {
      success: true,
      data: { message: result.message },
      message: result.message,
    };
  }

  @Post('profile/change-password')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Change own account password (alias)' })
  async changePasswordAlias(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<ApiResponse<{ message: string }>> {
    return this.changePassword(req, dto);
  }

  // ===========================================================================
  // SAVED DELIVERY ADDRESSES (PHASE 20D.8.2A)
  // ===========================================================================

  @Get('me/addresses')
  @Version('1')
  @ApiOperation({ summary: 'List authenticated user saved delivery addresses' })
  async getMyAddresses(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<UserAddressResponseDto[]>> {
    const addresses = await this.usersService.getUserAddresses(req.user.id);
    return {
      success: true,
      data: addresses,
      message: 'Addresses retrieved successfully',
    };
  }

  @Post('me/addresses')
  @Version('1')
  @ApiOperation({ summary: 'Create a saved delivery address' })
  async createMyAddress(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateAddressDto,
  ): Promise<ApiResponse<UserAddressResponseDto>> {
    const address = await this.usersService.createUserAddress(req.user.id, dto);
    return {
      success: true,
      data: address,
      message: 'Address created successfully',
    };
  }

  @Put('me/addresses/:id')
  @Version('1')
  @ApiOperation({ summary: 'Update an owned saved delivery address' })
  async updateMyAddress(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<ApiResponse<UserAddressResponseDto>> {
    const updated = await this.usersService.updateUserAddress(
      req.user.id,
      id,
      dto,
    );
    return {
      success: true,
      data: updated,
      message: 'Address updated successfully',
    };
  }

  @Delete('me/addresses/:id')
  @Version('1')
  @ApiOperation({ summary: 'Delete an owned saved delivery address' })
  async deleteMyAddress(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ApiResponse<{ message: string }>> {
    const result = await this.usersService.deleteUserAddress(req.user.id, id);
    return {
      success: true,
      data: result,
      message: result.message,
    };
  }

  @Patch('me/addresses/:id/default')
  @Version('1')
  @ApiOperation({ summary: 'Set an owned saved delivery address as default' })
  async setMyAddressDefault(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ApiResponse<UserAddressResponseDto>> {
    const updated = await this.usersService.setDefaultUserAddress(
      req.user.id,
      id,
    );
    return {
      success: true,
      data: updated,
      message: 'Default address updated successfully',
    };
  }

  // ===========================================================================
  // BACKWARDS-COMPATIBLE & IDOR-PROTECTED ENDPOINTS
  // ===========================================================================


  @Get(':id')
  @Version('1')
  @ApiOperation({ summary: 'Get user by ID (enforces IDOR ownership protection)' })
  async findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ApiResponse<UserResponseDto>> {
    // IDOR Protection: regular USER can only view their own profile
    if (req.user.role === UserRole.USER && req.user.id !== id) {
      throw new ForbiddenException(
        'Access denied: You are not authorized to view other user profiles',
      );
    }

    const user = await this.usersService.findByIdOrFail(id);
    return {
      success: true,
      data: user,
    };
  }

  @Get()
  @Version('1')
  @UseGuards(FeaturesGuard, PermissionsGuard)
  @RequireFeatures(FeatureKey.USER_MANAGEMENT)
  @RequirePermissions(Permissions.USERS_VIEW)
  @ApiOperation({ summary: 'List all users (Admin only)' })
  async findAll(
    @Query() query: QueryUsersDto,
  ): Promise<ApiResponse<PaginatedUsersDto>> {
    const result = await this.usersService.findAdminUsers(query);
    return {
      success: true,
      data: result,
    };
  }
}
