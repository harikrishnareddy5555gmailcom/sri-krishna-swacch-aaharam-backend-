import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CACHE_PROVIDER, type ICacheProvider } from '../common/cache/index.js';
import {
  ProductStatus,
  AuditAction,
  AuditEntityType,
  type Product,
  type ProductVariant,
  type ProductVariantStatus,
  type ProductMedia,
  type MediaType,
  type CreateProductDto,
  type UpdateProductDto,
  type CreateProductVariantDto,
  type UpdateProductVariantDto,
  type CreateProductMediaDto,
  type PublicProductListItem,
  type PublicProductDetailDto,
} from '@vishkaraa/types';
import { CategoriesService } from './categories.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { StorageService } from '../common/storage/storage.service.js';
import type { MinimalUser } from '../permissions/permissions.service.js';
import type { Prisma } from '@prisma/client';
import type { PublicCatalogQuery, CatalogSortOption } from '@vishkaraa/types';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Optional()
    @Inject(CACHE_PROVIDER)
    private readonly cache?: ICacheProvider,
    @Optional()
    private readonly categoriesService?: CategoriesService,
    @Optional()
    private readonly inventoryService?: InventoryService,
    @Optional()
    private readonly storageService?: StorageService,
  ) {}

  private async executeTx<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction(callback);
    }
    return callback(this.prisma as unknown as Prisma.TransactionClient);
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private async generateUniqueSku(
    baseSku: string,
    excludeVariantId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = tx ?? this.prisma;
    const cleanBase = baseSku.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'SKU';
    let target = cleanBase;
    let counter = 2;
    while (true) {
      const existing = await client.productVariant.findUnique({
        where: { sku: target },
      });
      if (!existing || (excludeVariantId && existing.id === excludeVariantId)) {
        return target;
      }
      target = `${cleanBase}-${counter}`;
      counter++;
    }
  }

  /**
   * Invalidates cached public product queries deterministically.
   */
  private async invalidateProductCache(slug?: string): Promise<void> {
    if (!this.cache) return;
    if (slug) {
      await this.cache.delete(`catalog:products:slug:${slug}`);
    }
    await this.cache.deleteByPrefix('catalog:products:list:');
  }

  // ─── Public Catalog Queries ─────────────────────────────────────────────────

  /**
   * Helper to expand category IDs recursively, safe against missing categories and cycles.
   */
  private async expandCategoryIds(categoryIds: string[]): Promise<string[]> {
    if (this.categoriesService) {
      return this.categoriesService.expandCategoryIds(categoryIds);
    }
    if (!categoryIds || categoryIds.length === 0) return [];
    const allIds = new Set<string>();
    for (const catId of categoryIds) {
      if (!catId || typeof catId !== 'string') continue;
      const trimmed = catId.trim();
      if (!trimmed) continue;
      allIds.add(trimmed);
      const queue = [trimmed];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const children = await this.prisma.category.findMany({
          where: { parentId: current, status: { not: 'ARCHIVED' } },
          select: { id: true },
        });
        for (const c of children) {
          allIds.add(c.id);
          if (!visited.has(c.id)) {
            queue.push(c.id);
          }
        }
      }
    }
    return Array.from(allIds);
  }

  /**
   * Public: List active products with pagination, search, recursive category filtering, and sorting.
   * Never exposes draft/inactive/archived products.
   * Never exposes cost, inventory, or admin metadata.
   */
  async findPublicProducts(
    pageOrQuery: number | PublicCatalogQuery = 1,
    limitParam = 20,
    categoryIdParam?: string,
  ): Promise<{ data: PublicProductListItem[]; total: number; page: number; limit: number; totalPages: number }> {
    let rawPage = 1;
    let rawLimit = 20;
    let categoryId: string | undefined;
    let categoryIds: string | string[] | undefined;
    let search: string | undefined;
    let sortBy: CatalogSortOption | undefined;

    if (typeof pageOrQuery === 'number') {
      rawPage = pageOrQuery;
      rawLimit = limitParam;
      categoryId = categoryIdParam;
    } else if (pageOrQuery && typeof pageOrQuery === 'object') {
      rawPage = pageOrQuery.page ?? 1;
      rawLimit = pageOrQuery.limit ?? 20;
      categoryId = pageOrQuery.categoryId;
      categoryIds = pageOrQuery.categoryIds;
      search = pageOrQuery.search;
      sortBy = pageOrQuery.sortBy;
    }

    const page = Math.max(1, Math.floor(rawPage || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(rawLimit || 20)));

    // Normalize category selections
    const rawCategorySet = new Set<string>();
    if (categoryId && typeof categoryId === 'string' && categoryId.trim()) {
      rawCategorySet.add(categoryId.trim());
    }
    if (categoryIds) {
      const items = Array.isArray(categoryIds) ? categoryIds : categoryIds.split(',');
      for (const item of items) {
        if (typeof item === 'string' && item.trim()) {
          rawCategorySet.add(item.trim());
        }
      }
    }
    const rawCategoriesList = Array.from(rawCategorySet);
    const normalizedCategoryIds = [...rawCategoriesList].sort();

    // Normalize search query
    const trimmedSearch = search ? search.trim() : undefined;
    if (trimmedSearch && trimmedSearch.length > 100) {
      throw new BadRequestException('Search query cannot exceed 100 characters');
    }

    // Validate sort option
    const validSortOptions: CatalogSortOption[] = ['price_asc', 'price_desc', 'name_asc', 'featured'];
    if (sortBy && !validSortOptions.includes(sortBy)) {
      throw new BadRequestException(
        `Invalid sortBy parameter. Allowed values: ${validSortOptions.join(', ')}`,
      );
    }
    const effectiveSortBy = sortBy && sortBy !== 'featured' ? sortBy : undefined;

    const fetcher = async () => {
      const skip = (page - 1) * limit;

      // Expand categories recursively to include all descendants
      const targetCategoryIds = rawCategoriesList.length > 0
        ? await this.expandCategoryIds(rawCategoriesList)
        : [];

      const where: Prisma.ProductWhereInput = {
        status: 'ACTIVE',
      };

      if (targetCategoryIds.length > 0) {
        where.categoryId = targetCategoryIds.length === 1 ? targetCategoryIds[0] : { in: targetCategoryIds };
      }

      if (trimmedSearch) {
        where.OR = [
          { name: { contains: trimmedSearch, mode: 'insensitive' } },
          { shortDescription: { contains: trimmedSearch, mode: 'insensitive' } },
          { description: { contains: trimmedSearch, mode: 'insensitive' } },
        ];
      }

      let products: Array<
        Prisma.ProductGetPayload<{
          include: {
            media: true;
            variants: {
              include: {
                inventoryItem: {
                  select: {
                    onHand: true;
                    reserved: true;
                    committed: true;
                    lowStockThreshold: true;
                  };
                };
              };
            };
          };
        }>
      > = [];
      let total = 0;

      const includeClause = {
        media: {
          where: { isPrimary: true },
          take: 1,
          orderBy: { sortOrder: 'asc' as const },
        },
        variants: {
          where: { status: 'ACTIVE' as const },
          orderBy: [{ sortOrder: 'asc' as const }, { price: 'asc' as const }],
          take: 1,
          include: {
            inventoryItem: {
              select: {
                onHand: true,
                reserved: true,
                committed: true,
                lowStockThreshold: true,
              },
            },
          },
        },
      };

      if (effectiveSortBy === 'price_asc' || effectiveSortBy === 'price_desc') {
        const sortDirection = effectiveSortBy === 'price_asc' ? 'asc' : 'desc';

        // 1. Group active variants to get products ordered by min price before pagination
        const [variantGroups, totalGroups] = await Promise.all([
          this.prisma.productVariant.groupBy({
            by: ['productId'],
            where: {
              status: 'ACTIVE',
              product: where,
            },
            _min: {
              price: true,
            },
            orderBy: [
              {
                _min: {
                  price: sortDirection,
                },
              },
              {
                productId: 'asc', // Deterministic secondary ordering
              },
            ],
            skip,
            take: limit,
          }),
          this.prisma.productVariant.groupBy({
            by: ['productId'],
            where: {
              status: 'ACTIVE',
              product: where,
            },
          }),
        ]);

        total = totalGroups.length;
        const pageProductIds = variantGroups.map((g) => g.productId);

        if (pageProductIds.length > 0) {
          const rawProducts = await this.prisma.product.findMany({
            where: { id: { in: pageProductIds } },
            include: includeClause,
          });

          // Preserve exact ordering from variantGroups
          const productMap = new Map(rawProducts.map((p) => [p.id, p]));
          products = pageProductIds
            .map((id) => productMap.get(id))
            .filter((p): p is (typeof rawProducts)[number] => p !== undefined);
        } else {
          products = [];
        }
      } else {
        // Name sort or default sort (createdAt desc)
        const orderBy: Prisma.ProductOrderByWithRelationInput[] =
          effectiveSortBy === 'name_asc'
            ? [{ name: 'asc' }, { id: 'asc' }]
            : [{ createdAt: 'desc' }, { id: 'asc' }];

        const [fetchedProducts, count] = await Promise.all([
          this.prisma.product.findMany({
            where,
            skip,
            take: limit,
            orderBy,
            include: includeClause,
          }),
          this.prisma.product.count({ where }),
        ]);

        products = fetchedProducts;
        total = count;
      }

      const data: PublicProductListItem[] = products.map((p) => {
        const lowestVariant = p.variants[0];
        const inv = lowestVariant?.inventoryItem;
        const availableStock = inv ? Math.max(0, inv.onHand - inv.reserved - inv.committed) : undefined;
        const threshold = inv?.lowStockThreshold ?? (p.metadata as Record<string, unknown> | null)?.['lowStockThreshold'] ?? 10;
        const isOutOfStock = availableStock !== undefined ? availableStock <= 0 : false;
        const isLowStock = availableStock !== undefined && !isOutOfStock ? availableStock <= Number(threshold) : false;

        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          shortDescription: p.shortDescription ?? undefined,
          brand: p.brand ?? undefined,
          categoryId: p.categoryId,
          primaryImage: p.media[0]
            ? { url: p.media[0].url, altText: p.media[0].altText ?? undefined }
            : undefined,
          fromPrice: lowestVariant?.price ?? undefined,
          fromCompareAtPrice: lowestVariant?.compareAtPrice ?? undefined,
          currency: lowestVariant?.currency ?? 'INR',
          defaultVariantId: lowestVariant?.id,
          metadata: (p.metadata as Record<string, unknown>) ?? undefined,
          isLowStock,
          isOutOfStock,
        };
      });

      return {
        data,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    };

    if (this.cache) {
      const catKey = normalizedCategoryIds.length > 0 ? normalizedCategoryIds.join(',') : 'all';
      const searchKey = trimmedSearch ? `:search=${encodeURIComponent(trimmedSearch.toLowerCase())}` : '';
      const sortKey = effectiveSortBy ? `:sort=${effectiveSortBy}` : '';
      const cacheKey = `catalog:products:list:${page}:${limit}:${catKey}${searchKey}${sortKey}`;
      return this.cache.getOrSet(cacheKey, fetcher, 120);
    }
    return fetcher();
  }

  /**
   * Public: Get full product detail by slug.
   * Only works for ACTIVE products. Returns variants and media.
   */
  async findPublicBySlug(slug: string): Promise<PublicProductDetailDto> {
    const fetcher = async () => {
      const product = await this.prisma.product.findUnique({
        where: { slug },
        include: {
          variants: {
            where: { status: 'ACTIVE' },
            orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
            include: {
              inventoryItem: {
                select: {
                  onHand: true,
                  reserved: true,
                  committed: true,
                  lowStockThreshold: true,
                },
              },
            },
          },
          media: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
          },
        },
      });

      if (!product || product.status !== 'ACTIVE') {
        throw new NotFoundException(`Product '${slug}' not found`);
      }

      const primaryImage = product.media.find((m) => m.isPrimary);
      const lowestVariant = product.variants[0];
      const inv = lowestVariant?.inventoryItem;
      const availableStock = inv ? Math.max(0, inv.onHand - inv.reserved - inv.committed) : undefined;
      const threshold = inv?.lowStockThreshold ?? (product.metadata as Record<string, unknown> | null)?.['lowStockThreshold'] ?? 10;
      const isOutOfStock = availableStock !== undefined ? availableStock <= 0 : false;
      const isLowStock = availableStock !== undefined && !isOutOfStock ? availableStock <= Number(threshold) : false;

      return {
        id: product.id,
        name: product.name,
        slug: product.slug,
        shortDescription: product.shortDescription ?? undefined,
        description: product.description ?? undefined,
        brand: product.brand ?? undefined,
        categoryId: product.categoryId,
        primaryImage: primaryImage
          ? { url: primaryImage.url, altText: primaryImage.altText ?? undefined }
          : undefined,
        fromPrice: lowestVariant?.price ?? undefined,
        fromCompareAtPrice: lowestVariant?.compareAtPrice ?? undefined,
        currency: lowestVariant?.currency ?? 'INR',
        metadata: (product.metadata as Record<string, unknown>) ?? undefined,
        images: product.images && product.images.length > 0
          ? product.images
          : product.media.filter((m) => !m.variantId).map((m) => m.url),
        isLowStock,
        isOutOfStock,
        variants: product.variants.map((v) => {
          const inv = v.inventoryItem;
          const avail = inv ? Math.max(0, inv.onHand - inv.reserved - inv.committed) : undefined;
          return {
            id: v.id,
            name: v.name,
            packageSize: v.packageSize ?? v.name,
            imageUrl: v.imageUrl ?? undefined,
            mediaUrls: v.mediaUrls ?? [],
            isDefault: v.isDefault,
            sku: v.sku,
            price: v.price,
            compareAtPrice: v.compareAtPrice ?? undefined,
            currency: v.currency,
            status: v.status as ProductVariantStatus,
            sortOrder: v.sortOrder,
            attributes: v.attributes as Record<string, string> | undefined,
            availableStock: avail,
            isOutOfStock: avail !== undefined ? avail <= 0 : false,
          };
        }),
        media: product.media.map((m) => ({
          id: m.id,
          variantId: m.variantId ?? undefined,
          mediaType: m.mediaType as MediaType,
          url: m.url,
          altText: m.altText ?? undefined,
          sortOrder: m.sortOrder,
          isPrimary: m.isPrimary,
        })),
      };
    };

    if (this.cache) {
      const cacheKey = `catalog:products:slug:${slug}`;
      return this.cache.getOrSet(cacheKey, fetcher, 300);
    }
    return fetcher();
  }

  // ─── Admin Queries ──────────────────────────────────────────────────────────

  /**
   * Admin: List all products with all statuses and pagination.
   */
  async findAll(
    page = 1,
    limit = 20,
    status?: ProductStatus,
    categoryId?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.ProductWhereInput = {
      ...(status && { status }),
      ...(categoryId && { categoryId }),
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          category: {
            select: {
              id: true,
              name: true,
              slug: true,
              parentId: true,
              parent: { select: { id: true, name: true, slug: true } },
            },
          },
          media: {
            select: { id: true, url: true, altText: true, isPrimary: true },
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
          },
          variants: {
            select: {
              id: true,
              name: true,
              sku: true,
              price: true,
              compareAtPrice: true,
              status: true,
              inventoryItem: {
                select: {
                  onHand: true,
                  reserved: true,
                  committed: true,
                  lowStockThreshold: true,
                },
              },
            },
            orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
          },
          _count: { select: { variants: true, media: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: products,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Admin: Get full product detail by ID.
   */
  async findById(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        category: {
          include: {
            parent: true,
          },
        },
        variants: {
          orderBy: [{ sortOrder: 'asc' }],
          include: {
            inventoryItem: true,
          },
        },
        media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      },
    });
    if (!product) {
      throw new NotFoundException(`Product '${id}' not found`);
    }
    return product;
  }

  /**
   * Admin: Create a new product with atomic variant & media synchronization.
   */
  async create(dto: CreateProductDto, actor: MinimalUser): Promise<Product> {
    return this.executeTx(async (tx) => {
      // 1. Generate unique slug
      const rawSlug = dto.slug && dto.slug.trim() ? dto.slug.trim() : this.slugify(dto.name);
      let finalSlug = this.slugify(rawSlug);
      let counter = 2;
      while (await tx.product.findUnique({ where: { slug: finalSlug } })) {
        finalSlug = `${this.slugify(rawSlug)}-${counter}`;
        counter++;
      }

      // 2. Validate category exists
      const category = await tx.category.findUnique({
        where: { id: dto.categoryId },
      });
      if (!category) {
        throw new NotFoundException(`Category '${dto.categoryId}' not found`);
      }
      if (category.status === 'ARCHIVED') {
        throw new BadRequestException('Cannot create product in an archived category');
      }

      // 3. Create product
      const product = await tx.product.create({
        data: {
          name: dto.name,
          slug: finalSlug,
          shortDescription: dto.shortDescription,
          description: dto.description,
          categoryId: dto.categoryId,
          brand: dto.brand,
          status: dto.status ?? 'DRAFT',
          images: dto.images ?? [],
          metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonObject) : undefined,
        },
      });

      // 4. Create shared ProductMedia if dto.images provided
      if (dto.images && dto.images.length > 0) {
        for (let i = 0; i < dto.images.length; i++) {
          const imgUrl = dto.images[i];
          if (imgUrl && !imgUrl.startsWith('blob:')) {
            await tx.productMedia.create({
              data: {
                productId: product.id,
                url: imgUrl,
                altText: `${product.name} image ${i + 1}`,
                isPrimary: i === 0,
                sortOrder: i,
              },
            });
          }
        }
      }

      // 5. Handle variants if provided
      if (dto.variants && dto.variants.length > 0) {
        for (let i = 0; i < dto.variants.length; i++) {
          const vDto = dto.variants[i];
          const packageSize = vDto.packageSize?.trim() || 'Standard';
          const variantName = vDto.title?.trim() || vDto.name?.trim() || `${product.name} - ${packageSize}`;
          const isDefault = vDto.isDefault ?? (i === 0);
          const rawSku = vDto.sku?.trim() || `VN-${finalSlug.slice(0, 8).toUpperCase()}-${this.slugify(packageSize).toUpperCase()}`;
          const uniqueSku = await this.generateUniqueSku(rawSku, undefined, tx);

          const variant = await tx.productVariant.create({
            data: {
              productId: product.id,
              name: variantName,
              packageSize,
              sku: uniqueSku,
              price: vDto.price,
              compareAtPrice: vDto.compareAtPrice ?? null,
              currency: 'INR',
              status: vDto.isActive === false ? 'INACTIVE' : 'ACTIVE',
              sortOrder: i,
              isDefault,
              imageUrl: vDto.imageUrl ?? null,
              mediaUrls: vDto.mediaUrls ?? [],
            },
          });

          // Size-specific image in productMedia
          if (vDto.imageUrl && !vDto.imageUrl.startsWith('blob:')) {
            await tx.productMedia.create({
              data: {
                productId: product.id,
                variantId: variant.id,
                url: vDto.imageUrl,
                altText: `${product.name} - ${packageSize}`,
                isPrimary: false,
                sortOrder: 100 + i,
              },
            });
          }

          // Initial inventory ledger reconciliation
          const stock = typeof vDto.stock === 'number' ? Math.max(0, vDto.stock) : 0;
          if (stock > 0) {
            const invItem = await tx.inventoryItem.create({
              data: {
                variantId: variant.id,
                onHand: stock,
                reserved: 0,
                committed: 0,
                lowStockThreshold: 5,
                version: 1,
              },
            });
            await tx.inventoryMovement.create({
              data: {
                idempotencyKey: `init_${variant.id}_${Date.now()}_${i}`,
                inventoryItemId: invItem.id,
                variantId: variant.id,
                type: 'INITIAL_STOCK',
                quantityDelta: stock,
                onHandAfter: stock,
                reservedAfter: 0,
                committedAfter: 0,
                referenceType: 'ADMIN',
                referenceId: product.id,
                actorId: actor.id,
                reason: 'Initial stock on creation',
              },
            });
          }
        }
      }

      await this.auditService.logEvent({
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        action: AuditAction.PRODUCT_CREATED,
        entityType: AuditEntityType.PRODUCT,
        entityId: product.id,
        newValue: { name: product.name, slug: product.slug, status: product.status },
      });

      await this.invalidateProductCache(product.slug);
      return product as unknown as Product;
    });
  }

  /**
   * Admin: Update a product with atomic variant & media synchronization.
   */
  async update(id: string, dto: UpdateProductDto, actor: MinimalUser): Promise<Product> {
    return this.executeTx(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException(`Product '${id}' not found`);
      }

      let targetSlug = existing.slug;
      if (dto.slug && dto.slug !== existing.slug) {
        targetSlug = this.slugify(dto.slug);
        let counter = 2;
        while (true) {
          const conflict = await tx.product.findUnique({ where: { slug: targetSlug } });
          if (!conflict || conflict.id === id) break;
          targetSlug = `${this.slugify(dto.slug)}-${counter}`;
          counter++;
        }
      }

      if (dto.categoryId && dto.categoryId !== existing.categoryId) {
        const category = await tx.category.findUnique({
          where: { id: dto.categoryId },
        });
        if (!category) {
          throw new NotFoundException(`Category '${dto.categoryId}' not found`);
        }
        if (category.status === 'ARCHIVED') {
          throw new BadRequestException('Cannot move product to an archived category');
        }
      }

      // Update parent product
      const updated = await tx.product.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.slug !== undefined && { slug: targetSlug }),
          ...(dto.shortDescription !== undefined && { shortDescription: dto.shortDescription }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
          ...(dto.brand !== undefined && { brand: dto.brand }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.images !== undefined && { images: dto.images }),
          ...(dto.metadata !== undefined && {
            metadata: dto.metadata as Prisma.InputJsonObject,
          }),
        },
      });

      // Synchronize shared ProductMedia if dto.images provided
      if (dto.images !== undefined) {
        await tx.productMedia.deleteMany({
          where: { productId: id, variantId: null },
        });
        for (let i = 0; i < dto.images.length; i++) {
          const imgUrl = dto.images[i];
          if (imgUrl && !imgUrl.startsWith('blob:')) {
            await tx.productMedia.create({
              data: {
                productId: id,
                url: imgUrl,
                altText: `${updated.name} image ${i + 1}`,
                isPrimary: i === 0,
                sortOrder: i,
              },
            });
          }
        }
      }

      // Synchronize variants atomically if dto.variants provided
      if (dto.variants !== undefined && Array.isArray(dto.variants)) {
        const dbVariants = await tx.productVariant.findMany({
          where: { productId: id },
          include: { inventoryItem: true },
        });
        const dbVariantMap = new Map(dbVariants.map((v) => [v.id, v]));
        const keptVariantIds = new Set<string>();

        for (let i = 0; i < dto.variants.length; i++) {
          const vDto = dto.variants[i];
          const packageSize = vDto.packageSize?.trim() || 'Standard';
          const variantName = vDto.title?.trim() || vDto.name?.trim() || `${updated.name} - ${packageSize}`;
          const isDefault = vDto.isDefault ?? (i === 0);
          const rawSku = vDto.sku?.trim() || `VN-${updated.slug.slice(0, 8).toUpperCase()}-${this.slugify(packageSize).toUpperCase()}`;

          if (vDto.id && dbVariantMap.has(vDto.id)) {
            // ── Update existing variant ──
            keptVariantIds.add(vDto.id);
            const dbVar = dbVariantMap.get(vDto.id)!;
            const uniqueSku = await this.generateUniqueSku(rawSku, dbVar.id, tx);

            await tx.productVariant.update({
              where: { id: dbVar.id },
              data: {
                name: variantName,
                packageSize,
                sku: uniqueSku,
                price: vDto.price,
                compareAtPrice: vDto.compareAtPrice ?? null,
                imageUrl: vDto.imageUrl ?? null,
                mediaUrls: vDto.mediaUrls ?? [],
                isDefault,
                sortOrder: i,
                status: vDto.isActive === false ? 'INACTIVE' : 'ACTIVE',
              },
            });

            // Update or create size-specific ProductMedia
            if (vDto.imageUrl && !vDto.imageUrl.startsWith('blob:')) {
              const existingVarMedia = await tx.productMedia.findFirst({
                where: { variantId: dbVar.id },
              });
              if (existingVarMedia) {
                await tx.productMedia.update({
                  where: { id: existingVarMedia.id },
                  data: { url: vDto.imageUrl },
                });
              } else {
                await tx.productMedia.create({
                  data: {
                    productId: id,
                    variantId: dbVar.id,
                    url: vDto.imageUrl,
                    altText: `${updated.name} - ${packageSize}`,
                    isPrimary: false,
                    sortOrder: 100 + i,
                  },
                });
              }
            }

            // Reconcile Inventory via Ledger
            if (typeof vDto.stock === 'number') {
              const inv = dbVar.inventoryItem;
              const currentOnHand = inv?.onHand ?? 0;
              const delta = vDto.stock - currentOnHand;
              if (delta !== 0) {
                const targetOnHand = Math.max(0, vDto.stock);
                if (inv) {
                  // Guard against violating active commitments
                  const activeObligations = inv.reserved + inv.committed;
                  if (targetOnHand < activeObligations) {
                    throw new BadRequestException(
                      `Cannot set stock for size '${packageSize}' to ${targetOnHand}. It would violate ${activeObligations} active reserved/committed orders.`,
                    );
                  }
                  await tx.inventoryItem.update({
                    where: { id: inv.id },
                    data: { onHand: targetOnHand, version: { increment: 1 } },
                  });
                  await tx.inventoryMovement.create({
                    data: {
                      idempotencyKey: `adj_${dbVar.id}_${Date.now()}_${i}`,
                      inventoryItemId: inv.id,
                      variantId: dbVar.id,
                      type: delta > 0 ? 'ADMIN_ADJUSTMENT_INCREASE' : 'ADMIN_ADJUSTMENT_DECREASE',
                      quantityDelta: delta,
                      onHandAfter: targetOnHand,
                      reservedAfter: inv.reserved,
                      committedAfter: inv.committed,
                      referenceType: 'ADMIN',
                      referenceId: id,
                      actorId: actor.id,
                      reason: `Admin package size inventory update for ${packageSize}`,
                    },
                  });
                } else {
                  // If inventory record didn't exist yet, initialize it
                  const newInv = await tx.inventoryItem.create({
                    data: {
                      variantId: dbVar.id,
                      onHand: targetOnHand,
                      reserved: 0,
                      committed: 0,
                      lowStockThreshold: 5,
                      version: 1,
                    },
                  });
                  await tx.inventoryMovement.create({
                    data: {
                      idempotencyKey: `init_${dbVar.id}_${Date.now()}_${i}`,
                      inventoryItemId: newInv.id,
                      variantId: dbVar.id,
                      type: 'INITIAL_STOCK',
                      quantityDelta: targetOnHand,
                      onHandAfter: targetOnHand,
                      reservedAfter: 0,
                      committedAfter: 0,
                      referenceType: 'ADMIN',
                      referenceId: id,
                      actorId: actor.id,
                      reason: `Initial stock creation for ${packageSize}`,
                    },
                  });
                }
              }
            }
          } else {
            // ── Create new variant ──
            const uniqueSku = await this.generateUniqueSku(rawSku, undefined, tx);
            const newVar = await tx.productVariant.create({
              data: {
                productId: id,
                name: variantName,
                packageSize,
                sku: uniqueSku,
                price: vDto.price,
                compareAtPrice: vDto.compareAtPrice ?? null,
                currency: 'INR',
                status: vDto.isActive === false ? 'INACTIVE' : 'ACTIVE',
                sortOrder: i,
                isDefault,
                imageUrl: vDto.imageUrl ?? null,
                mediaUrls: vDto.mediaUrls ?? [],
              },
            });
            keptVariantIds.add(newVar.id);

            // Size-specific image
            if (vDto.imageUrl && !vDto.imageUrl.startsWith('blob:')) {
              await tx.productMedia.create({
                data: {
                  productId: id,
                  variantId: newVar.id,
                  url: vDto.imageUrl,
                  altText: `${updated.name} - ${packageSize}`,
                  isPrimary: false,
                  sortOrder: 100 + i,
                },
              });
            }

            // Inventory intake for new variant
            const stock = typeof vDto.stock === 'number' ? Math.max(0, vDto.stock) : 0;
            if (stock > 0) {
              const newInv = await tx.inventoryItem.create({
                data: {
                  variantId: newVar.id,
                  onHand: stock,
                  reserved: 0,
                  committed: 0,
                  lowStockThreshold: 5,
                  version: 1,
                },
              });
              await tx.inventoryMovement.create({
                data: {
                  idempotencyKey: `init_${newVar.id}_${Date.now()}_${i}`,
                  inventoryItemId: newInv.id,
                  variantId: newVar.id,
                  type: 'INITIAL_STOCK',
                  quantityDelta: stock,
                  onHandAfter: stock,
                  reservedAfter: 0,
                  committedAfter: 0,
                  referenceType: 'ADMIN',
                  referenceId: id,
                  actorId: actor.id,
                  reason: `Initial stock creation for ${packageSize}`,
                },
              });
            }
          }
        }

        // ── Deactivate / Soft-delete variants removed by admin ──
        for (const existingVar of dbVariants) {
          if (!keptVariantIds.has(existingVar.id) && existingVar.status !== 'DISCONTINUED') {
            await tx.productVariant.update({
              where: { id: existingVar.id },
              data: { status: 'DISCONTINUED' },
            });
          }
        }
      }

      const action = this.resolveProductAction(existing.status, updated.status);
      await this.auditService.logEvent({
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        action,
        entityType: AuditEntityType.PRODUCT,
        entityId: id,
        previousValue: { name: existing.name, status: existing.status },
        newValue: { name: updated.name, status: updated.status },
      });

      await this.invalidateProductCache(existing.slug);
      if (updated.slug !== existing.slug) {
        await this.invalidateProductCache(updated.slug);
      }
      return updated as unknown as Product;
    });
  }

  /**
   * Admin: Archive a product (soft-delete).
   */
  async archive(id: string, actor: MinimalUser): Promise<Product> {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Product '${id}' not found`);
    }
    if (existing.status === 'ARCHIVED') {
      throw new BadRequestException(`Product '${id}' is already archived`);
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.PRODUCT_ARCHIVED,
      entityType: AuditEntityType.PRODUCT,
      entityId: id,
      previousValue: { status: existing.status },
      newValue: { status: 'ARCHIVED' },
    });

    await this.invalidateProductCache(existing.slug);
    return updated as unknown as Product;
  }

  // ─── Variant Management ─────────────────────────────────────────────────────

  async createVariant(
    productId: string,
    dto: CreateProductVariantDto,
    actor: MinimalUser,
  ): Promise<ProductVariant> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException(`Product '${productId}' not found`);
    }

    if (dto.price !== undefined && dto.price <= 0) {
      throw new BadRequestException('Variant price must be a positive integer greater than 0');
    }
    if (
      dto.compareAtPrice !== undefined &&
      dto.compareAtPrice !== null &&
      dto.compareAtPrice < dto.price
    ) {
      throw new BadRequestException('compareAtPrice must be greater than or equal to price');
    }

    // SKU uniqueness across ALL products
    const skuConflict = await this.prisma.productVariant.findUnique({
      where: { sku: dto.sku },
    });
    if (skuConflict) {
      throw new ConflictException(`SKU '${dto.sku}' already exists`);
    }

    const variant = await this.prisma.productVariant.create({
      data: {
        productId,
        name: dto.name,
        packageSize: dto.packageSize ?? dto.name,
        sku: dto.sku,
        price: dto.price,
        compareAtPrice: dto.compareAtPrice ?? null,
        currency: dto.currency ?? 'INR',
        status: dto.status ?? 'ACTIVE',
        sortOrder: dto.sortOrder ?? 0,
        isDefault: dto.isDefault ?? false,
        imageUrl: dto.imageUrl ?? null,
        mediaUrls: dto.mediaUrls ?? [],
        attributes: dto.attributes ? (dto.attributes as Prisma.InputJsonObject) : undefined,
      },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.VARIANT_CREATED,
      entityType: AuditEntityType.PRODUCT_VARIANT,
      entityId: variant.id,
      newValue: { productId, name: variant.name, sku: variant.sku, price: variant.price },
    });

    await this.invalidateProductCache(product.slug);
    return variant as unknown as ProductVariant;
  }

  async updateVariant(
    productId: string,
    variantId: string,
    dto: UpdateProductVariantDto,
    actor: MinimalUser,
  ): Promise<ProductVariant> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
    if (!variant || variant.productId !== productId) {
      throw new NotFoundException(`Variant '${variantId}' not found on product '${productId}'`);
    }

    if (dto.sku && dto.sku !== variant.sku) {
      const skuConflict = await this.prisma.productVariant.findUnique({
        where: { sku: dto.sku },
      });
      if (skuConflict) {
        throw new ConflictException(`SKU '${dto.sku}' already exists`);
      }
    }

    const effectivePrice = dto.price !== undefined ? dto.price : variant.price;
    const effectiveCompareAtPrice =
      dto.compareAtPrice !== undefined ? dto.compareAtPrice : variant.compareAtPrice;

    if (dto.price !== undefined && dto.price <= 0) {
      throw new BadRequestException('Variant price must be a positive integer greater than 0');
    }
    if (
      effectiveCompareAtPrice !== null &&
      effectiveCompareAtPrice !== undefined &&
      effectiveCompareAtPrice < effectivePrice
    ) {
      throw new BadRequestException('compareAtPrice must be greater than or equal to price');
    }

    const updated = await this.prisma.productVariant.update({
      where: { id: variantId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.packageSize !== undefined && { packageSize: dto.packageSize }),
        ...(dto.sku !== undefined && { sku: dto.sku }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.compareAtPrice !== undefined && { compareAtPrice: dto.compareAtPrice }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
        ...(dto.mediaUrls !== undefined && { mediaUrls: dto.mediaUrls }),
        ...(dto.attributes !== undefined && {
          attributes: dto.attributes,
        }),
      },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.VARIANT_UPDATED,
      entityType: AuditEntityType.PRODUCT_VARIANT,
      entityId: variantId,
      previousValue: { status: variant.status, price: variant.price },
      newValue: { status: updated.status, price: updated.price },
    });

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { slug: true },
    });
    await this.invalidateProductCache(product?.slug);
    return updated as unknown as ProductVariant;
  }

  async deleteVariant(
    productId: string,
    variantId: string,
    actor: MinimalUser,
  ): Promise<void> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
    if (!variant || variant.productId !== productId) {
      throw new NotFoundException(`Variant '${variantId}' not found on product '${productId}'`);
    }

    // Soft-delete: set status to DISCONTINUED
    await this.prisma.productVariant.update({
      where: { id: variantId },
      data: { status: 'DISCONTINUED' },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.VARIANT_DEACTIVATED,
      entityType: AuditEntityType.PRODUCT_VARIANT,
      entityId: variantId,
      previousValue: { status: variant.status },
      newValue: { status: 'DISCONTINUED' },
    });

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { slug: true },
    });
    await this.invalidateProductCache(product?.slug);
  }

  // ─── Media Management ───────────────────────────────────────────────────────

  async addMedia(
    productId: string,
    dto: CreateProductMediaDto,
    actor: MinimalUser,
  ): Promise<ProductMedia> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException(`Product '${productId}' not found`);
    }

    // If setting as primary, unset existing primary
    if (dto.isPrimary) {
      await this.prisma.productMedia.updateMany({
        where: { productId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const media = await this.prisma.productMedia.create({
      data: {
        productId,
        variantId: dto.variantId ?? null,
        mediaType: dto.mediaType ?? 'IMAGE',
        url: dto.url,
        altText: dto.altText ?? null,
        sortOrder: dto.sortOrder ?? 0,
        isPrimary: dto.isPrimary ?? false,
      },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.MEDIA_ADDED,
      entityType: AuditEntityType.PRODUCT_MEDIA,
      entityId: media.id,
      newValue: { productId, url: media.url, isPrimary: media.isPrimary },
    });

    await this.invalidateProductCache(product.slug);
    return media as unknown as ProductMedia;
  }

  async removeMedia(
    productId: string,
    mediaId: string,
    actor: MinimalUser,
  ): Promise<void> {
    const media = await this.prisma.productMedia.findUnique({ where: { id: mediaId } });
    if (!media || media.productId !== productId) {
      throw new NotFoundException(`Media '${mediaId}' not found on product '${productId}'`);
    }

    await this.prisma.productMedia.delete({ where: { id: mediaId } });

    // Permanently remove from Cloudflare R2 object storage
    if (this.storageService && media.url) {
      try {
        await this.storageService.deleteFile(media.url, actor);
      } catch (err: unknown) {
        this.logger.warn(`Failed to delete media file from R2: ${(err as Error).message}`);
      }
    }

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.MEDIA_REMOVED,
      entityType: AuditEntityType.PRODUCT_MEDIA,
      entityId: mediaId,
      previousValue: { productId, url: media.url },
    });

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { slug: true },
    });
    await this.invalidateProductCache(product?.slug);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private resolveProductAction(
    previousStatus: string,
    newStatus: string,
  ): AuditAction {
    if (newStatus === 'ACTIVE' && previousStatus !== 'ACTIVE') {
      return AuditAction.PRODUCT_PUBLISHED;
    }
    if (newStatus === 'ARCHIVED') {
      return AuditAction.PRODUCT_ARCHIVED;
    }
    if (newStatus === 'INACTIVE') {
      return AuditAction.PRODUCT_DEACTIVATED;
    }
    return AuditAction.PRODUCT_UPDATED;
  }
}
