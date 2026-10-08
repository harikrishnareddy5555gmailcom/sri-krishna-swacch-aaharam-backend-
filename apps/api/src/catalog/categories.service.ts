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
import type {
  Category,
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryTree,
} from '@vishkaraa/types';
import { AuditAction, AuditEntityType } from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Optional()
    @Inject(CACHE_PROVIDER)
    private readonly cache?: ICacheProvider,
  ) {}

  /**
   * Invalidates category caches and public product listing caches on category changes.
   */
  private async invalidateCategoryCache(slug?: string): Promise<void> {
    if (!this.cache) return;
    if (slug) {
      await this.cache.delete(`catalog:categories:slug:${slug}`);
    }
    await this.cache.deleteByPrefix('catalog:categories:');
    await this.cache.deleteByPrefix('catalog:products:list:');
  }

  /**
   * List all non-archived categories (public & admin).
   */
  async findAll(includeArchived = false): Promise<Category[]> {
    const fetcher = async () => {
      const rows = await this.prisma.category.findMany({
        where: includeArchived
          ? {}
          : { status: { not: 'ARCHIVED' } },
        include: {
          _count: {
            select: { products: true },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows.map((r) => ({
        ...r,
        productCount: r._count?.products ?? 0,
      })) as unknown as Category[];
    };

    if (!includeArchived && this.cache) {
      return this.cache.getOrSet('catalog:categories:list', fetcher, 300);
    }
    return fetcher();
  }

  /**
   * Return categories as a tree, with children nested under parents.
   */
  async findTree(activeOnly = true): Promise<CategoryTree[]> {
    const fetcher = async () => {
      const allCategories = await this.findAll(!activeOnly);
      return this.buildTree(allCategories);
    };

    if (activeOnly && this.cache) {
      return this.cache.getOrSet('catalog:categories:tree', fetcher, 300);
    }
    return fetcher();
  }

  /**
   * Find a single category by ID.
   */
  async findById(id: string): Promise<Category> {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException(`Category '${id}' not found`);
    }
    return category as unknown as Category;
  }

  /**
   * Find a single category by slug (public-facing).
   */
  async findBySlug(slug: string): Promise<Category> {
    const fetcher = async () => {
      const category = await this.prisma.category.findUnique({
        where: { slug },
        include: { _count: { select: { products: true } } },
      });
      if (!category || category.status === 'ARCHIVED') {
        throw new NotFoundException(`Category '${slug}' not found`);
      }
      return {
        ...category,
        productCount: category._count?.products ?? 0,
      } as unknown as Category;
    };

    if (this.cache) {
      return this.cache.getOrSet(`catalog:categories:slug:${slug}`, fetcher, 300);
    }
    return fetcher();
  }

  /**
   * Create a new category.
   * Validates: slug uniqueness, parent existence, prevents self-referential cycles.
   */
  async create(dto: CreateCategoryDto, actor: MinimalUser): Promise<Category> {
    // Check slug uniqueness
    const slugConflict = await this.prisma.category.findUnique({
      where: { slug: dto.slug },
    });
    if (slugConflict) {
      throw new ConflictException(`Category slug '${dto.slug}' already exists`);
    }

    // Validate parent if provided
    if (dto.parentId) {
      const parent = await this.prisma.category.findUnique({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new NotFoundException(`Parent category '${dto.parentId}' not found`);
      }
      if (parent.status === 'ARCHIVED') {
        throw new BadRequestException(`Cannot add child to an ARCHIVED category`);
      }
    }

    const category = await this.prisma.category.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        imageUrl: dto.imageUrl,
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? 0,
        status: (dto.status ?? 'ACTIVE'),
      },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.CATEGORY_CREATED,
      entityType: AuditEntityType.CATEGORY,
      entityId: category.id,
      newValue: { name: category.name, slug: category.slug, parentId: category.parentId },
    });

    await this.invalidateCategoryCache(category.slug);
    return category as unknown as Category;
  }

  /**
   * Update an existing category.
   * Validates: slug uniqueness, circular parent reference prevention.
   */
  async update(id: string, dto: UpdateCategoryDto, actor: MinimalUser): Promise<Category> {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Category '${id}' not found`);
    }

    // Slug uniqueness (exclude self)
    if (dto.slug && dto.slug !== existing.slug) {
      const slugConflict = await this.prisma.category.findUnique({
        where: { slug: dto.slug },
      });
      if (slugConflict) {
        throw new ConflictException(`Category slug '${dto.slug}' already exists`);
      }
    }

    // Validate parent: prevent circular reference
    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent (circular reference)');
      }
      const parent = await this.prisma.category.findUnique({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new NotFoundException(`Parent category '${dto.parentId}' not found`);
      }
      // Deep cycle check: ensure proposed parent is not a descendant of this category
      const isDescendant = await this.isDescendantOf(dto.parentId, id);
      if (isDescendant) {
        throw new BadRequestException(
          'Circular category reference detected: proposed parent is a descendant of this category',
        );
      }
    }

    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.slug !== undefined && { slug: dto.slug }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
        ...(dto.parentId !== undefined && {
          parent: dto.parentId === null
            ? { disconnect: true }
            : { connect: { id: dto.parentId } },
        }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.status !== undefined && {
          status: dto.status,
        }),
      },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.CATEGORY_UPDATED,
      entityType: AuditEntityType.CATEGORY,
      entityId: id,
      previousValue: { name: existing.name, status: existing.status },
      newValue: { name: updated.name, status: updated.status },
    });

    await this.invalidateCategoryCache(existing.slug);
    if (updated.slug !== existing.slug) {
      await this.invalidateCategoryCache(updated.slug);
    }
    return updated as unknown as Category;
  }

  /**
   * Archive a category (soft-delete).
   * Validates: category has no active products.
   */
  async archive(id: string, actor: MinimalUser): Promise<Category> {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Category '${id}' not found`);
    }
    if (existing.status === 'ARCHIVED') {
      throw new BadRequestException(`Category '${id}' is already archived`);
    }

    // Ensure no active products reference this category
    const activeProductCount = await this.prisma.product.count({
      where: { categoryId: id, status: { not: 'ARCHIVED' } },
    });
    if (activeProductCount > 0) {
      throw new ConflictException(
        `Cannot archive category '${id}': it contains ${activeProductCount} active product(s). ` +
          'Archive or move those products first.',
      );
    }

    const updated = await this.prisma.category.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });

    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: AuditAction.CATEGORY_ARCHIVED,
      entityType: AuditEntityType.CATEGORY,
      entityId: id,
      previousValue: { status: existing.status },
      newValue: { status: 'ARCHIVED' },
    });

    await this.invalidateCategoryCache(existing.slug);
    return updated as unknown as Category;
  }

  /**
   * Returns rootCategoryId and all its descendant category IDs recursively.
   * - Includes the root category ID itself.
   * - Eliminates duplicates.
   * - Prevents infinite loops using a visited Set (cyclic safety).
   * - Safe against non-existent category IDs.
   */
  async getDescendantCategoryIds(rootCategoryId: string): Promise<string[]> {
    if (!rootCategoryId || typeof rootCategoryId !== 'string') return [];
    const trimmed = rootCategoryId.trim();
    if (!trimmed) return [];

    const result = new Set<string>([trimmed]);
    const queue = [trimmed];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      let children: Array<{ id: string }>;
      try {
        children = await this.prisma.category.findMany({
          where: { parentId: current, status: { not: 'ARCHIVED' } },
          select: { id: true },
        });
      } catch (err) {
        this.logger.error(
          `Failed to fetch child categories for category '${current}' during hierarchy expansion`,
        );
        throw err;
      }

      for (const child of children) {
        result.add(child.id);
        if (!visited.has(child.id)) {
          queue.push(child.id);
        }
      }
    }

    return Array.from(result);
  }

  /**
   * Expands multiple category IDs to include all recursive descendants.
   * Combines results into a unique array without duplicates.
   */
  async expandCategoryIds(categoryIds: string[]): Promise<string[]> {
    if (!categoryIds || categoryIds.length === 0) return [];
    const allIds = new Set<string>();
    for (const catId of categoryIds) {
      if (!catId || typeof catId !== 'string') continue;
      const trimmed = catId.trim();
      if (!trimmed) continue;
      const descendants = await this.getDescendantCategoryIds(trimmed);
      for (const d of descendants) {
        allIds.add(d);
      }
    }
    return Array.from(allIds);
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Checks whether `candidateId` is a descendant of `ancestorId`.
   * Used to prevent circular category hierarchies.
   */
  private async isDescendantOf(candidateId: string, ancestorId: string): Promise<boolean> {
    // BFS traversal of children
    const queue = [candidateId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      if (current === ancestorId) return true;

      const children = await this.prisma.category.findMany({
        where: { parentId: current },
        select: { id: true },
      });
      queue.push(...children.map((c) => c.id));
    }
    return false;
  }

  /**
   * Builds a hierarchical tree from a flat list of categories.
   */
  private buildTree(categories: Category[]): CategoryTree[] {
    const map = new Map<string, CategoryTree>();
    const roots: CategoryTree[] = [];

    for (const cat of categories) {
      map.set(cat.id, { ...cat, children: [] });
    }

    for (const cat of categories) {
      const node = map.get(cat.id)!;
      if (cat.parentId && map.has(cat.parentId)) {
        const parent = map.get(cat.parentId)!;
        parent.children = parent.children ?? [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}
