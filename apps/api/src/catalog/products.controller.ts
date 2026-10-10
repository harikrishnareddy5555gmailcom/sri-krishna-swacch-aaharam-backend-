import {
  Controller,
  Get,
  Post,
  Put,
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
  ParseIntPipe,
  DefaultValuePipe,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { Permissions, ProductStatus, type CatalogSortOption } from '@vishkaraa/types';
import { ProductsService } from './products.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import {
  CreateProductValidationDto,
  UpdateProductValidationDto,
  QuickCreateProductDto,
} from './dto/product.dto.js';
import { CreateVariantValidationDto, UpdateVariantValidationDto } from './dto/variant.dto.js';
import { CreateMediaValidationDto } from './dto/media.dto.js';
import {
  RequestUploadUrlDto,
  UploadDirectMediaDto,
  DeleteDirectMediaDto,
} from './dto/request-upload-url.dto.js';
import { StorageService } from '../common/storage/storage.service.js';
import type { MinimalUser } from '../permissions/permissions.service.js';

interface AuthenticatedRequest {
  user: MinimalUser;
}

const ALLOWED_SORT_OPTIONS = new Set(['price_asc', 'price_desc', 'name_asc', 'featured']);
const CATEGORY_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

// ─── Public Catalog Endpoints ─────────────────────────────────────────────────

@Controller('catalog/products')
export class PublicProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /**
   * GET /api/v1/catalog/products
   * Public: List active products with pagination, recursive category filtering, search, and sorting.
   */
  @Get()
  async findAll(
    @Res({ passthrough: true }) res: Response,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number = 20,
    @Query('categoryId') categoryId?: string,
    @Query('categoryIds') categoryIds?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
  ) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (page < 1) {
      throw new BadRequestException('page must be an integer greater than or equal to 1');
    }

    if (limit < 1) {
      throw new BadRequestException('limit must be an integer greater than or equal to 1');
    }

    if (search !== undefined && search.trim().length > 100) {
      throw new BadRequestException('Search query exceeds maximum length of 100 characters');
    }

    if (sortBy !== undefined && !ALLOWED_SORT_OPTIONS.has(sortBy)) {
      throw new BadRequestException('Invalid sortBy parameter. Allowed values: price_asc, price_desc, name_asc');
    }

    let validatedCategoryId: string | undefined = undefined;
    if (categoryId !== undefined) {
      const trimmed = categoryId.trim();
      if (!trimmed) {
        throw new BadRequestException('categoryId cannot be empty when provided');
      }
      if (!CATEGORY_ID_REGEX.test(trimmed)) {
        throw new BadRequestException(`Invalid categoryId format: '${categoryId}'`);
      }
      validatedCategoryId = trimmed;
    }

    let parsedCategoryIds: string[] | undefined = undefined;
    if (categoryIds !== undefined) {
      const rawList = categoryIds.split(',').map((c) => c.trim());
      if (rawList.length === 0 || rawList.every((c) => c.length === 0)) {
        throw new BadRequestException('categoryIds cannot be empty when provided');
      }
      for (const catId of rawList) {
        if (!catId) {
          throw new BadRequestException('categoryIds contains empty category ID entry');
        }
        if (!CATEGORY_ID_REGEX.test(catId)) {
          throw new BadRequestException(`Invalid category ID format in categoryIds: '${catId}'`);
        }
      }
      parsedCategoryIds = Array.from(new Set(rawList));
    }

    const safeLimit = Math.min(limit, 100);

    return this.productsService.findPublicProducts({
      page,
      limit: safeLimit,
      categoryId: validatedCategoryId,
      categoryIds: parsedCategoryIds,
      search: search?.trim() || undefined,
      sortBy: sortBy as CatalogSortOption | undefined,
    });
  }

  /**
   * GET /api/v1/catalog/products/:slug
   * Public: Get active product detail by slug (includes active variants and media).
   */
  @Get(':slug')
  async findBySlug(
    @Res({ passthrough: true }) res: Response,
    @Param('slug') slug: string,
  ) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return this.productsService.findPublicBySlug(slug);
  }
}

// ─── Admin Catalog Endpoints ──────────────────────────────────────────────────

@Controller('admin/products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class AdminProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly inventoryService: InventoryService,
  ) {}

  /**
   * GET /api/v1/admin/products/low-stock-count
   * Admin: Count products/variants with inventory at or below low stock threshold.
   * Used by the Dashboard Low Stock Alert card.
   */
  @Get('low-stock-count')
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  async getLowStockCount(): Promise<{
    count: number;
    lowStockCount: number;
    totalOnHand: number;
    totalAvailable: number;
    totalCommitted: number;
  }> {
    const summary = await this.inventoryService.getInventorySummary();
    return {
      count: summary.lowStockCount,
      ...summary,
    };
  }

  /**
   * GET /api/v1/admin/products
   * Admin: List all products (all statuses).
   */
  @Get()
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: ProductStatus,
    @Query('categoryId') categoryId?: string,
  ) {
    const safeLimit = Math.min(limit, 100);
    return this.productsService.findAll(page, safeLimit, status, categoryId);
  }

  /**
   * GET /api/v1/admin/products/:id
   * Admin: Get product by ID (all statuses, with variants and media).
   */
  @Get(':id')
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.findById(id);
  }

  /**
   * POST /api/v1/admin/products
   * Admin: Create a new product.
   */
  @Post()
  @RequirePermissions(Permissions.PRODUCTS_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateProductValidationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.create(dto, req.user);
  }

  /**
   * POST /api/v1/admin/products/quick-create
   * Admin: Quick create product with variants in one step (Phase 5).
   */
  @Post('quick-create')
  @RequirePermissions(Permissions.PRODUCTS_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async quickCreate(
    @Body() dto: QuickCreateProductDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.quickCreate(dto, req.user);
  }

  /**
   * PUT /api/v1/admin/products/:id
   * PATCH /api/v1/admin/products/:id
   * Admin: Update product details (name, description, status, etc.).
   */
  @Put(':id')
  @Patch(':id')
  @RequirePermissions(Permissions.PRODUCTS_UPDATE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductValidationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.update(id, dto, req.user);
  }

  /**
   * PATCH /api/v1/admin/products/:id/publish
   * Admin: Publish (activate) a product.
   */
  @Patch(':id/publish')
  @RequirePermissions(Permissions.PRODUCTS_PUBLISH)
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.update(id, { status: ProductStatus.ACTIVE }, req.user);
  }

  /**
   * DELETE /api/v1/admin/products/:id
   * Admin: Archive a product (soft-delete).
   */
  @Delete(':id')
  @RequirePermissions(Permissions.PRODUCTS_DELETE)
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.archive(id, req.user);
  }
}

// ─── Admin Variant Endpoints ──────────────────────────────────────────────────

@Controller('admin/products/:productId/variants')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class AdminVariantsController {
  constructor(private readonly productsService: ProductsService) {}

  /**
   * POST /api/v1/admin/products/:productId/variants
   * Admin: Add a variant to a product.
   */
  @Post()
  @RequirePermissions(Permissions.PRODUCT_VARIANTS_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateVariantValidationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.createVariant(productId, dto, req.user);
  }

  /**
   * PATCH /api/v1/admin/products/:productId/variants/:variantId
   * Admin: Update a variant.
   */
  @Patch(':variantId')
  @RequirePermissions(Permissions.PRODUCT_VARIANTS_UPDATE)
  async update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantValidationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.updateVariant(productId, variantId, dto, req.user);
  }

  /**
   * DELETE /api/v1/admin/products/:productId/variants/:variantId
   * Admin: Deactivate (discontinue) a variant.
   */
  @Delete(':variantId')
  @RequirePermissions(Permissions.PRODUCT_VARIANTS_DELETE)
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.productsService.deleteVariant(productId, variantId, req.user);
    return { message: 'Variant discontinued successfully' };
  }
}

// ─── Admin Media Endpoints ────────────────────────────────────────────────────

@Controller('admin/products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class AdminMediaController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * POST /api/v1/admin/products/media/upload-url
   * Admin: Get a secure presigned upload URL for Cloudflare R2 / S3 storage.
   */
  @Post('media/upload-url')
  @RequirePermissions(Permissions.PRODUCT_MEDIA_MANAGE)
  @HttpCode(HttpStatus.OK)
  async getUploadUrl(
    @Body() dto: RequestUploadUrlDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const result = await this.storageService.generateProductMediaUploadUrl(
      dto.fileName,
      dto.contentType,
      dto.fileSizeBytes,
      req.user,
    );
    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/admin/products/media/upload-direct
   * Admin: Directly upload product media via backend proxy to Cloudflare R2 / S3.
   * Completely eliminates browser CORS restrictions on S3/R2 endpoints.
   */
  @Post('media/upload-direct')
  @RequirePermissions(Permissions.PRODUCT_MEDIA_MANAGE)
  @HttpCode(HttpStatus.OK)
  async uploadDirect(
    @Body() dto: UploadDirectMediaDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const base64Data = dto.dataBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const result = await this.storageService.uploadProductMediaDirect(
      buffer,
      dto.fileName,
      dto.contentType,
      req.user,
    );
    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/admin/products/media/delete-direct
   * Admin: Permanently delete an uploaded media file from Cloudflare R2 storage.
   */
  @Post('media/delete-direct')
  @RequirePermissions(Permissions.PRODUCT_MEDIA_MANAGE)
  @HttpCode(HttpStatus.OK)
  async deleteDirect(
    @Body() dto: DeleteDirectMediaDto,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.storageService.deleteFile(dto.url, req.user);
    return {
      success: true,
      message: 'Media deleted permanently from storage',
    };
  }

  /**
   * POST /api/v1/admin/products/:productId/media
   * Admin: Add media to a product.
   */
  @Post(':productId/media')
  @RequirePermissions(Permissions.PRODUCT_MEDIA_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateMediaValidationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.productsService.addMedia(productId, dto, req.user);
  }

  /**
   * DELETE /api/v1/admin/products/:productId/media/:mediaId
   * Admin: Remove a media item from a product.
   */
  @Delete(':productId/media/:mediaId')
  @RequirePermissions(Permissions.PRODUCT_MEDIA_MANAGE)
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.productsService.removeMedia(productId, mediaId, req.user);
    return { message: 'Media removed successfully' };
  }
}

