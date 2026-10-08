import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  Req,
  Res,
  Version,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  type ApiResponse,
  type StorefrontContentDto,
  type StorefrontDraftDto,
  Permissions,
} from '@vishkaraa/types';
import { ContentService } from './content.service.js';
import type { MinimalUser } from '../permissions/permissions.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';

interface RequestWithUser {
  user: MinimalUser;
}

@ApiTags('content')
@Controller()
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  /**
   * GET /api/v1/content/storefront
   * Public: returns the active, published storefront content.
   */
  @Get('content/storefront')
  @Version('1')
  @ApiOperation({ summary: 'Get active published storefront configuration' })
  getPublishedStorefront(
    @Res({ passthrough: true }) res: Response,
  ): ApiResponse<StorefrontContentDto> {
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=60');
    const data = this.contentService.getPublishedContent();
    return {
      success: true,
      data,
      message: 'Storefront content retrieved',
    };
  }

  /**
   * GET /api/v1/admin/content
   * Admin: returns draft and published versions with modification audit info.
   */
  @Get('admin/content')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin inspection of storefront draft and published content' })
  getAdminContent(): ApiResponse<StorefrontDraftDto> {
    const data = this.contentService.getDraftContent();
    return {
      success: true,
      data,
      message: 'Storefront configuration retrieved',
    };
  }

  /**
   * PUT /api/v1/admin/content/draft
   * Admin: saves a modified draft.
   */
  @Put('admin/content/draft')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.SETTINGS_MANAGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save draft storefront configuration' })
  saveDraft(
    @Req() req: RequestWithUser,
    @Body() body: StorefrontContentDto,
  ): ApiResponse<StorefrontDraftDto> {
    const data = this.contentService.saveDraft(body, req.user);
    return {
      success: true,
      data,
      message: 'Storefront draft saved successfully',
    };
  }

  /**
   * POST /api/v1/admin/content/publish
   * Admin: publishes current draft to the live storefront.
   */
  @Post('admin/content/publish')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.SETTINGS_MANAGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Publish draft storefront configuration to production' })
  publishDraft(@Req() req: RequestWithUser): ApiResponse<StorefrontDraftDto> {
    const data = this.contentService.publishDraft(req.user);
    return {
      success: true,
      data,
      message: `Storefront content version ${data.published.version} published successfully`,
    };
  }

  /**
   * POST /api/v1/admin/content/revert
   * Admin: reverts current draft back to published version.
   */
  @Post('admin/content/revert')
  @Version('1')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permissions.SETTINGS_MANAGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revert draft to current published state' })
  revertDraft(@Req() req: RequestWithUser): ApiResponse<StorefrontDraftDto> {
    const data = this.contentService.revertDraft(req.user);
    return {
      success: true,
      data,
      message: 'Draft reverted to published state',
    };
  }
}
