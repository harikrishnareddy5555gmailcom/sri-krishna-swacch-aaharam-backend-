import { Controller, Get, UseGuards, Version } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  type ApiResponse,
  type RoleDefinition,
  Permissions,
} from '@vishkaraa/types';
import { RolesService } from './roles.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';

@ApiTags('roles')
@Controller()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('admin/roles')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.ROLES_VIEW)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List all system roles and their assigned permissions',
  })
  async getRoles(): Promise<ApiResponse<RoleDefinition[]>> {
    const data = await this.rolesService.getAllRoles();
    return {
      success: true,
      data,
      message: 'Roles and permission baselines retrieved',
    };
  }
}
