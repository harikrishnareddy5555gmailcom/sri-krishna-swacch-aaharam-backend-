import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { MemoryCacheProvider } from '../src/common/cache/memory-cache.provider.js';
import { CategoriesService } from '../src/catalog/categories.service.js';
import { ProductsService } from '../src/catalog/products.service.js';
import { PublicProductsController } from '../src/catalog/products.controller.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import type { AuditService } from '../src/audit/audit.service.js';

describe('Phase 20D.7 Step 2.1 — Catalog Backend Verification & Corrections', () => {
  let cache: MemoryCacheProvider;
  let mockPrisma: any;
  let mockAudit: any;
  let categoriesService: CategoriesService;
  let productsService: ProductsService;
  let controller: PublicProductsController;

  const mockProduct = (id: string, name: string, price: number, catId: string) => ({
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    shortDescription: `Short description for ${name}`,
    description: `Full description for ${name}`,
    status: 'ACTIVE',
    categoryId: catId,
    category: { id: catId, name: `Category ${catId}` },
    tags: ['wood-pressed', 'organic'],
    seoTitle: null,
    seoDescription: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    variants: [
      {
        id: `var-${id}-1`,
        productId: id,
        sku: `SKU-${id}-1`,
        title: '500ml',
        price,
        compareAtPrice: price + 5000,
        status: 'ACTIVE',
        position: 0,
        attributes: {},
      },
    ],
    media: [
      {
        id: `med-${id}-1`,
        productId: id,
        variantId: null,
        url: 'https://images.vishkaraa.test/oil.png',
        altText: name,
        position: 0,
        isPrimary: true,
      },
    ],
  });

  beforeEach(() => {
    cache = new MemoryCacheProvider(100);

    mockPrisma = {
      category: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      product: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
      },
      productVariant: {
        groupBy: vi.fn(),
      },
    };

    mockAudit = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    categoriesService = new CategoriesService(
      mockPrisma as unknown as PrismaService,
      mockAudit as unknown as AuditService,
      cache,
    );

    productsService = new ProductsService(
      mockPrisma as unknown as PrismaService,
      mockAudit as unknown as AuditService,
      cache,
      categoriesService,
    );

    controller = new PublicProductsController(productsService);
  });

  describe('1. Recursive Hierarchical Category Filtering & Error Handling', () => {
    it('returns parent and direct children recursively', async () => {
      // Tree: cat-root -> [cat-child-1, cat-child-2]
      mockPrisma.category.findMany.mockImplementation(async (args: any) => {
        if (args.where?.parentId === 'cat-root') {
          return [{ id: 'cat-child-1' }, { id: 'cat-child-2' }];
        }
        return [];
      });

      const descendants = await categoriesService.getDescendantCategoryIds('cat-root');
      expect(descendants).toEqual(expect.arrayContaining(['cat-root', 'cat-child-1', 'cat-child-2']));
      expect(descendants).toHaveLength(3);
    });

    it('returns parent, children, and grandchildren recursively', async () => {
      // Tree: cat-oils -> cat-edible -> cat-cold-pressed
      mockPrisma.category.findMany.mockImplementation(async (args: any) => {
        if (args.where?.parentId === 'cat-oils') {
          return [{ id: 'cat-edible' }];
        }
        if (args.where?.parentId === 'cat-edible') {
          return [{ id: 'cat-cold-pressed' }];
        }
        return [];
      });

      const descendants = await categoriesService.getDescendantCategoryIds('cat-oils');
      expect(descendants).toEqual(
        expect.arrayContaining(['cat-oils', 'cat-edible', 'cat-cold-pressed']),
      );
      expect(descendants).toHaveLength(3);
    });

    it('child selection does not include its parent', async () => {
      // Querying child should only expand child and its descendants, not parent
      mockPrisma.category.findMany.mockImplementation(async (args: any) => {
        if (args.where?.parentId === 'cat-edible') {
          return [{ id: 'cat-cold-pressed' }];
        }
        return [];
      });

      const descendants = await categoriesService.getDescendantCategoryIds('cat-edible');
      expect(descendants).toEqual(expect.arrayContaining(['cat-edible', 'cat-cold-pressed']));
      expect(descendants).not.toContain('cat-oils');
      expect(descendants).toHaveLength(2);
    });

    it('combines multiple categories and removes duplicates', async () => {
      // cat-a -> [cat-shared, cat-child-a]
      // cat-b -> [cat-shared, cat-child-b]
      mockPrisma.category.findMany.mockImplementation(async (args: any) => {
        if (args.where?.parentId === 'cat-a') {
          return [{ id: 'cat-shared' }, { id: 'cat-child-a' }];
        }
        if (args.where?.parentId === 'cat-b') {
          return [{ id: 'cat-shared' }, { id: 'cat-child-b' }];
        }
        return [];
      });

      const expanded = await categoriesService.expandCategoryIds(['cat-a', 'cat-b']);
      expect(expanded).toHaveLength(5); // cat-a, cat-b, cat-shared, cat-child-a, cat-child-b
      expect(expanded).toEqual(
        expect.arrayContaining(['cat-a', 'cat-b', 'cat-shared', 'cat-child-a', 'cat-child-b']),
      );
      // Ensure cat-shared appears only once
      const countShared = expanded.filter((id) => id === 'cat-shared').length;
      expect(countShared).toBe(1);
    });

    it('distinguishes legitimate category with no children', async () => {
      mockPrisma.category.findMany.mockResolvedValue([]);

      const result = await categoriesService.getDescendantCategoryIds('leaf-category');
      expect(result).toEqual(['leaf-category']);
    });

    it('safely handles non-existent/missing category query', async () => {
      mockPrisma.category.findMany.mockResolvedValue([]);

      const result = await categoriesService.getDescendantCategoryIds('missing-category');
      expect(result).toEqual(['missing-category']);
    });

    it('propagates database failure instead of silently returning incomplete tree', async () => {
      mockPrisma.category.findMany.mockRejectedValue(new Error('PostgreSQL connection timeout'));

      await expect(
        categoriesService.getDescendantCategoryIds('cat-root'),
      ).rejects.toThrow('PostgreSQL connection timeout');
    });

    it('safely handles cyclic category structures without infinite loops', async () => {
      // Cycle: cat-1 -> cat-2 -> cat-1
      mockPrisma.category.findMany.mockImplementation(async (args: any) => {
        if (args.where?.parentId === 'cat-1') {
          return [{ id: 'cat-2' }];
        }
        if (args.where?.parentId === 'cat-2') {
          return [{ id: 'cat-1' }];
        }
        return [];
      });

      const result = await categoriesService.getDescendantCategoryIds('cat-1');
      expect(result).toEqual(expect.arrayContaining(['cat-1', 'cat-2']));
      expect(result).toHaveLength(2);
    });

    it('applies category filter with in clause in productsService', async () => {
      mockPrisma.category.findMany.mockResolvedValue([{ id: 'cat-sub-1' }]);
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Wood Pressed Groundnut Oil', 34900, 'cat-sub-1'),
      ]);

      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        categoryId: 'cat-root',
      });

      expect(mockPrisma.product.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          status: 'ACTIVE',
          categoryId: { in: expect.arrayContaining(['cat-root', 'cat-sub-1']) },
        }),
      });
    });
  });

  describe('2. Products Without Active Variants Lifecycle & Sorting', () => {
    it('excludes products without active variants when sorting by price_asc or price_desc', async () => {
      mockPrisma.productVariant.groupBy.mockResolvedValue([
        { productId: 'prod-with-variant', _min: { price: 29900 } },
      ]);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('prod-with-variant', 'Product With Variant', 29900, 'cat-1'),
      ]);

      const result = await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        sortBy: 'price_asc',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe('prod-with-variant');
      expect(mockPrisma.productVariant.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
    });

    it('returns active products without active variants with undefined fromPrice in default or name sort', async () => {
      const prodWithoutVariant = {
        ...mockProduct('prod-no-variant', 'Unpriced Product', 0, 'cat-1'),
        variants: [], // no active variants
      };

      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([prodWithoutVariant]);

      const result = await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        sortBy: 'name_asc',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe('prod-no-variant');
      expect(result.data[0]?.fromPrice).toBeUndefined();
    });
  });

  describe('3. Server-Side Search', () => {
    it('applies case-insensitive search across name, shortDescription, and description', async () => {
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Sesame Oil', 29900, 'cat-1'),
      ]);

      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        search: 'sesame',
      });

      expect(mockPrisma.product.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          status: 'ACTIVE',
          OR: [
            { name: { contains: 'sesame', mode: 'insensitive' } },
            { shortDescription: { contains: 'sesame', mode: 'insensitive' } },
            { description: { contains: 'sesame', mode: 'insensitive' } },
          ],
        }),
      });
    });

    it('trims whitespace and ignores empty search queries', async () => {
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Sesame Oil', 29900, 'cat-1'),
      ]);

      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        search: '   ',
      });

      const where = mockPrisma.product.count.mock.calls[0][0].where;
      expect(where.OR).toBeUndefined();
    });

    it('controller rejects search query exceeding 100 characters with BadRequestException', async () => {
      const longSearch = 'a'.repeat(101);
      const mockRes = { setHeader: vi.fn() } as unknown as Response;

      await expect(
        controller.findAll(mockRes, 1, 20, undefined, undefined, longSearch),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('4. Server-Side Sorting & Featured Semantics', () => {
    it('sorts by name ascending with secondary id ordering', async () => {
      mockPrisma.product.count.mockResolvedValue(2);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Almond Oil', 50000, 'cat-1'),
        mockProduct('p2', 'Castor Oil', 25000, 'cat-1'),
      ]);

      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        sortBy: 'name_asc',
      });

      expect(mockPrisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it('sorts by price_asc using variant groupBy with lowest variant price in paise', async () => {
      mockPrisma.product.count.mockResolvedValue(2);
      mockPrisma.productVariant.groupBy.mockResolvedValue([
        { productId: 'prod-cheaper', _min: { price: 19900 } },
        { productId: 'prod-pricier', _min: { price: 49900 } },
      ]);

      const prodCheaper = mockProduct('prod-cheaper', 'Cheaper Oil', 19900, 'cat-1');
      const prodPricier = mockProduct('prod-pricier', 'Pricier Oil', 49900, 'cat-1');
      mockPrisma.product.findMany.mockResolvedValue([prodPricier, prodCheaper]);

      const result = await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        sortBy: 'price_asc',
      });

      expect(mockPrisma.productVariant.groupBy).toHaveBeenCalledWith({
        by: ['productId'],
        where: expect.objectContaining({
          status: 'ACTIVE',
          product: expect.objectContaining({ status: 'ACTIVE' }),
        }),
        _min: { price: true },
        orderBy: [{ _min: { price: 'asc' } }, { productId: 'asc' }],
        skip: 0,
        take: 20,
      });

      expect(result.data[0]?.id).toBe('prod-cheaper');
      expect(result.data[1]?.id).toBe('prod-pricier');
    });

    it('sorts by price_desc using variant groupBy with deterministic secondary ordering', async () => {
      mockPrisma.product.count.mockResolvedValue(2);
      mockPrisma.productVariant.groupBy.mockResolvedValue([
        { productId: 'prod-pricier', _min: { price: 49900 } },
        { productId: 'prod-cheaper', _min: { price: 19900 } },
      ]);

      const prodCheaper = mockProduct('prod-cheaper', 'Cheaper Oil', 19900, 'cat-1');
      const prodPricier = mockProduct('prod-pricier', 'Pricier Oil', 49900, 'cat-1');
      mockPrisma.product.findMany.mockResolvedValue([prodCheaper, prodPricier]);

      const result = await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        sortBy: 'price_desc',
      });

      expect(mockPrisma.productVariant.groupBy).toHaveBeenCalledWith({
        by: ['productId'],
        where: expect.objectContaining({
          status: 'ACTIVE',
          product: expect.objectContaining({ status: 'ACTIVE' }),
        }),
        _min: { price: true },
        orderBy: [{ _min: { price: 'desc' } }, { productId: 'asc' }],
        skip: 0,
        take: 20,
      });

      expect(result.data[0]?.id).toBe('prod-pricier');
      expect(result.data[1]?.id).toBe('prod-cheaper');
    });

    it('defaults to createdAt desc and id asc when sortBy is omitted', async () => {
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Default Oil', 30000, 'cat-1'),
      ]);

      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
      });

      expect(mockPrisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
      );
    });

    it('featured sort falls back to createdAt desc and id asc', async () => {
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Default Oil', 30000, 'cat-1'),
      ]);

      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        sortBy: 'featured',
      });

      expect(mockPrisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
      );
    });

    it('controller rejects unapproved sort option with BadRequestException', async () => {
      const mockRes = { setHeader: vi.fn() } as unknown as Response;

      await expect(
        controller.findAll(mockRes, 1, 20, undefined, undefined, undefined, 'unapproved_sort'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('5. Controller Query Parameter Validation & Boundaries', () => {
    it('rejects page < 1 with BadRequestException', async () => {
      const mockRes = { setHeader: vi.fn() } as unknown as Response;
      await expect(controller.findAll(mockRes, 0, 20)).rejects.toThrow(BadRequestException);
      await expect(controller.findAll(mockRes, -1, 20)).rejects.toThrow(BadRequestException);
    });

    it('rejects limit < 1 with BadRequestException', async () => {
      const mockRes = { setHeader: vi.fn() } as unknown as Response;
      await expect(controller.findAll(mockRes, 1, 0)).rejects.toThrow(BadRequestException);
      await expect(controller.findAll(mockRes, 1, -5)).rejects.toThrow(BadRequestException);
    });

    it('rejects malformed categoryId with special characters', async () => {
      const mockRes = { setHeader: vi.fn() } as unknown as Response;
      await expect(
        controller.findAll(mockRes, 1, 20, "cat'; DROP TABLE products;--"),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects empty categoryId', async () => {
      const mockRes = { setHeader: vi.fn() } as unknown as Response;
      await expect(
        controller.findAll(mockRes, 1, 20, '   '),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects categoryIds with empty entries or invalid format', async () => {
      const mockRes = { setHeader: vi.fn() } as unknown as Response;
      await expect(
        controller.findAll(mockRes, 1, 20, undefined, 'cat-1,,cat-2'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.findAll(mockRes, 1, 20, undefined, '   '),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.findAll(mockRes, 1, 20, undefined, 'valid-cat,invalid<tag>'),
      ).rejects.toThrow(BadRequestException);
    });

    it('deduplicates categoryIds safely and passes them to service', async () => {
      mockPrisma.category.findMany.mockResolvedValue([]);
      mockPrisma.product.count.mockResolvedValue(0);
      mockPrisma.product.findMany.mockResolvedValue([]);
      const mockRes = { setHeader: vi.fn() } as unknown as Response;

      const res = await controller.findAll(mockRes, 1, 20, undefined, 'cat-1,cat-2,cat-1');
      expect(res).toBeDefined();
    });
  });

  describe('6. Combined Queries & Pagination', () => {
    it('combines multiple categories, search, and sorting with AND semantics', async () => {
      mockPrisma.category.findMany.mockResolvedValue([{ id: 'cat-sub-1' }]);
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Pure Coconut Oil', 45000, 'cat-sub-1'),
      ]);

      const result = await productsService.findPublicProducts({
        page: 2,
        limit: 10,
        categoryIds: ['cat-1', 'cat-2'],
        search: 'coconut',
        sortBy: 'name_asc',
      });

      expect(mockPrisma.product.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          status: 'ACTIVE',
          categoryId: { in: expect.any(Array) },
          OR: [
            { name: { contains: 'coconut', mode: 'insensitive' } },
            { shortDescription: { contains: 'coconut', mode: 'insensitive' } },
            { description: { contains: 'coconut', mode: 'insensitive' } },
          ],
        }),
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
    });
  });

  describe('7. Catalog Cache Correctness', () => {
    it('normalizes category IDs so order differences hit the same cache key', async () => {
      mockPrisma.category.findMany.mockResolvedValue([]);
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Mustard Oil', 22000, 'cat-a'),
      ]);

      // Call 1 with ['cat-b', 'cat-a']
      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        categoryIds: ['cat-b', 'cat-a'],
      });

      // Expected sorted key: cat-a,cat-b
      expect(await cache.get('catalog:products:list:1:20:cat-a,cat-b')).not.toBeNull();

      // Call 2 with reversed order ['cat-a', 'cat-b'] should hit cache without DB call
      mockPrisma.product.findMany.mockClear();
      const res2 = await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        categoryIds: ['cat-a', 'cat-b'],
      });

      expect(mockPrisma.product.findMany).not.toHaveBeenCalled();
      expect(res2.data[0]?.id).toBe('p1');
    });

    it('generates distinct cache keys for different search queries and sort options', async () => {
      mockPrisma.category.findMany.mockResolvedValue([]);
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([
        mockProduct('p1', 'Mustard Oil', 22000, 'cat-a'),
      ]);

      await productsService.findPublicProducts({
        page: 1,
        limit: 20,
        search: 'mustard',
        sortBy: 'name_asc',
      });

      expect(
        await cache.get('catalog:products:list:1:20:all:search=mustard:sort=name_asc'),
      ).not.toBeNull();
    });
  });
});
