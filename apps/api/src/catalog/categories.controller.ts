import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { Permissions } from '@vishkaraa/types';
import { CategoriesService } from './categories.service.js';
import { CreateCategoryValidationDto } from './dto/create-category.dto.js';
import { UpdateCategoryValidationDto } from './dto/update-category.dto.js';
import type { MinimalUser } from '../permissions/permissions.service.js';

interface AuthenticatedRequest {
  user: MinimalUser;
}

// ─── Public Catalog Endpoints ─────────────────────────────────────────────────

@Controller('catalog/categories')
export class PublicCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  /**
   * GET /api/v1/catalog/categories
   * Public: List all active categories.
   */
  @Get()
  async findAll(
    @Res({ passthrough: true }) res: Response,
    @Query('tree') tree?: string,
  ) {
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    if (tree === 'true') {
      return this.categoriesService.findTree(true);
    }
    const categories = await this.categoriesService.findAll(false);
    return categories;
  }

  /**
   * GET /api/v1/catalog/categories/:slug
   * Public: Get category by slug.
   */
  @Get(':slug')
  async findBySlug(
    @Res({ passthrough: true }) res: Response,
    @Param('slug') slug: string,
  ) {
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    return this.categoriesService.findBySlug(slug);
  }
}

// ─── Admin Catalog Endpoints ──────────────────────────────────────────────────

@Controller('admin/categories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  /**
   * GET /api/v1/admin/categories
   * Admin: List all categories (including inactive, excluding archived unless queried).
   */
  @Get()
  @RequirePermissions(Permissions.CATEGORIES_VIEW)
  async findAll(
    @Query('includeArchived') includeArchived?: string,
    @Query('tree') tree?: string,
  ) {
    const incArchived = includeArchived === 'true';
    if (tree === 'true') {
      return this.categoriesService.findTree(!incArchived);
    }
    return this.categoriesService.findAll(incArchived);
  }

  /**
   * GET /api/v1/admin/categories/:id
   * Admin: Get a category by ID.
   */
  @Get(':id')
  @RequirePermissions(Permissions.CATEGORIES_VIEW)
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.categoriesService.findById(id);
  }

  /**
   * POST /api/v1/admin/categories
   * Admin: Create a new category.
   */
  @Post()
  @RequirePermissions(Permissions.CATEGORIES_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateCategoryValidationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.categoriesService.create(dto, req.user);
  }

  /**
   * PATCH /api/v1/admin/categories/:id
   * Admin: Update an existing category.
   */
  @Patch(':id')
  @RequirePermissions(Permissions.CATEGORIES_UPDATE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryValidationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.categoriesService.update(id, dto, req.user);
  }

  /**
   * DELETE /api/v1/admin/categories/:id
   * Admin: Archive (soft-delete) or permanently delete category if ?hard=true.
   */
  @Delete(':id')
  @RequirePermissions(Permissions.CATEGORIES_DELETE)
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('hard') hard: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    if (hard === 'true') {
      return this.categoriesService.deletePermanent(id, req.user);
    }
    return this.categoriesService.archive(id, req.user);
  }
}
