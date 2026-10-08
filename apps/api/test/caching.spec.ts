import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryCacheProvider } from '../src/common/cache/memory-cache.provider.js';
import { ProductsService } from '../src/catalog/products.service.js';
import { CategoriesService } from '../src/catalog/categories.service.js';
import { PublicProductsController } from '../src/catalog/products.controller.js';
import { PublicCategoriesController } from '../src/catalog/categories.controller.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import type { AuditService } from '../src/audit/audit.service.js';
import type { Response } from 'express';

describe('Phase 19 — Evidence-Based Caching', () => {
  describe('MemoryCacheProvider (In-Process Cache)', () => {
    let cache: MemoryCacheProvider;

    beforeEach(() => {
      cache = new MemoryCacheProvider(5); // small limit for eviction testing
    });

    it('returns null on cache miss and increments misses metric', async () => {
      const result = await cache.get('missing-key');
      expect(result).toBeNull();
      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
    });

    it('stores and retrieves values (cache hit) and increments hits metric', async () => {
      await cache.set('catalog:product:1', { name: 'Herbal Soap', price: 29900 }, 60);
      const result = await cache.get<{ name: string; price: number }>('catalog:product:1');

      expect(result).toEqual({ name: 'Herbal Soap', price: 29900 });
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(1);
    });

    it('expires entries after TTL elapsed', async () => {
      vi.useFakeTimers();
      try {
        await cache.set('temp-key', 'ephemeral-data', 2); // 2 seconds TTL

        // Immediate check
        expect(await cache.get('temp-key')).toBe('ephemeral-data');

        // Advance 1 second: still valid
        vi.advanceTimersByTime(1000);
        expect(await cache.get('temp-key')).toBe('ephemeral-data');

        // Advance 1.5 more seconds: expired
        vi.advanceTimersByTime(1500);
        expect(await cache.get('temp-key')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('deletes specific keys correctly', async () => {
      await cache.set('key-a', 'val-a');
      await cache.set('key-b', 'val-b');

      await cache.delete('key-a');
      expect(await cache.get('key-a')).toBeNull();
      expect(await cache.get('key-b')).toBe('val-b');
    });

    it('deletes keys by prefix deterministically', async () => {
      await cache.set('catalog:products:list:1:20:all', 'page1');
      await cache.set('catalog:products:list:2:20:all', 'page2');
      await cache.set('catalog:products:slug:neem-soap', 'detail');
      await cache.set('catalog:categories:tree', 'categories');

      await cache.deleteByPrefix('catalog:products:list:');

      expect(await cache.get('catalog:products:list:1:20:all')).toBeNull();
      expect(await cache.get('catalog:products:list:2:20:all')).toBeNull();
      // Other keys should remain untouched
      expect(await cache.get('catalog:products:slug:neem-soap')).toBe('detail');
      expect(await cache.get('catalog:categories:tree')).toBe('categories');
    });

    it('clears all entries on clear()', async () => {
      await cache.set('key-1', 1);
      await cache.set('key-2', 2);
      await cache.clear();

      expect(await cache.get('key-1')).toBeNull();
      expect(await cache.get('key-2')).toBeNull();
      expect(cache.getStats().size).toBe(0);
    });

    it('bounds cache size and performs safe LRU-style eviction on capacity', async () => {
      // Cache initialized with maxEntries = 5
      await cache.set('k1', 1);
      await cache.set('k2', 2);
      await cache.set('k3', 3);
      await cache.set('k4', 4);
      await cache.set('k5', 5);

      expect(cache.getStats().size).toBe(5);

      // Access k1 to make it recently used
      await cache.get('k1');

      // Adding 6th entry should evict k2 (the oldest non-accessed key)
      await cache.set('k6', 6);

      expect(cache.getStats().size).toBe(5);
      expect(cache.getStats().evictions).toBe(1);
      expect(await cache.get('k2')).toBeNull();
      expect(await cache.get('k1')).toBe(1);
      expect(await cache.get('k6')).toBe(6);
    });

    it('provides stampede protection by deduplicating concurrent in-flight getOrSet calls', async () => {
      let factoryInvocations = 0;

      const slowFactory = async () => {
        factoryInvocations++;
        // Simulate asynchronous database query delay
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { data: 'heavy-query-result' };
      };

      // Launch 5 simultaneous requests for the same uncached key
      const results = await Promise.all([
        cache.getOrSet('expensive-key', slowFactory, 60),
        cache.getOrSet('expensive-key', slowFactory, 60),
        cache.getOrSet('expensive-key', slowFactory, 60),
        cache.getOrSet('expensive-key', slowFactory, 60),
        cache.getOrSet('expensive-key', slowFactory, 60),
      ]);

      // All 5 requests receive the correct result
      for (const res of results) {
        expect(res).toEqual({ data: 'heavy-query-result' });
      }

      // Factory was invoked strictly once
      expect(factoryInvocations).toBe(1);
    });
  });

  describe('ProductsService Caching & Invalidation Integration', () => {
    let cache: MemoryCacheProvider;
    let mockPrisma: any;
    let mockAudit: any;
    let productsService: ProductsService;

    const mockProductRow = {
      id: 'prod-uuid-1',
      name: 'Organic Aloe Vera Gel',
      slug: 'organic-aloe-vera-gel',
      shortDescription: 'Pure soothing gel',
      description: 'Full description',
      brand: 'Vishkaraa Naturals',
      categoryId: 'cat-uuid-1',
      status: 'ACTIVE',
      createdAt: new Date(),
      media: [
        { id: 'm1', url: 'https://cdn.example.com/aloe.jpg', altText: 'Aloe', isPrimary: true, sortOrder: 0, mediaType: 'IMAGE' },
      ],
      variants: [
        { id: 'v1', name: '200ml', sku: 'ALOE-200', price: 34900, compareAtPrice: 39900, currency: 'INR', status: 'ACTIVE', sortOrder: 0 },
      ],
    };

    beforeEach(() => {
      cache = new MemoryCacheProvider(100);
      mockPrisma = {
        product: {
          findMany: vi.fn().mockResolvedValue([mockProductRow]),
          count: vi.fn().mockResolvedValue(1),
          findUnique: vi.fn().mockResolvedValue(mockProductRow),
          create: vi.fn(),
          update: vi.fn(),
        },
        productVariant: {
          create: vi.fn(),
          update: vi.fn(),
          findUnique: vi.fn(),
        },
        productMedia: {
          create: vi.fn(),
          delete: vi.fn(),
          findUnique: vi.fn(),
          updateMany: vi.fn(),
        },
        category: {
          findUnique: vi.fn().mockResolvedValue({ id: 'cat-uuid-1', status: 'ACTIVE' }),
        },
      };
      mockAudit = {
        logEvent: vi.fn().mockResolvedValue(undefined),
      };

      productsService = new ProductsService(
        mockPrisma as unknown as PrismaService,
        mockAudit as unknown as AuditService,
        cache,
      );
    });

    it('caches findPublicProducts so second call does not query database', async () => {
      // First call (cache miss)
      const res1 = await productsService.findPublicProducts(1, 20);
      expect(res1.data).toHaveLength(1);
      expect(mockPrisma.product.findMany).toHaveBeenCalledTimes(1);

      // Second call (cache hit)
      const res2 = await productsService.findPublicProducts(1, 20);
      expect(res2.data).toEqual(res1.data);
      expect(mockPrisma.product.findMany).toHaveBeenCalledTimes(1); // Still 1!
    });

    it('caches findPublicBySlug so second call does not query database', async () => {
      // First call
      const res1 = await productsService.findPublicBySlug('organic-aloe-vera-gel');
      expect(res1.name).toBe('Organic Aloe Vera Gel');
      expect(mockPrisma.product.findUnique).toHaveBeenCalledTimes(1);

      // Second call
      const res2 = await productsService.findPublicBySlug('organic-aloe-vera-gel');
      expect(res2).toEqual(res1);
      expect(mockPrisma.product.findUnique).toHaveBeenCalledTimes(1);
    });

    it('invalidates product slug and listing cache when product is updated', async () => {
      // Warm the caches
      await productsService.findPublicProducts(1, 20);
      await productsService.findPublicBySlug('organic-aloe-vera-gel');

      expect(await cache.get('catalog:products:list:1:20:all')).not.toBeNull();
      expect(await cache.get('catalog:products:slug:organic-aloe-vera-gel')).not.toBeNull();

      // Perform update mutation
      mockPrisma.product.findUnique.mockResolvedValueOnce(mockProductRow); // for existing check
      mockPrisma.product.update.mockResolvedValueOnce({
        ...mockProductRow,
        name: 'Organic Aloe Vera Gel — New Formulation',
      });

      await productsService.update(
        'prod-uuid-1',
        { name: 'Organic Aloe Vera Gel — New Formulation' },
        { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com' } as any,
      );

      // Caches must be invalidated
      expect(await cache.get('catalog:products:list:1:20:all')).toBeNull();
      expect(await cache.get('catalog:products:slug:organic-aloe-vera-gel')).toBeNull();
    });

    it('invalidates cache when product is archived', async () => {
      await productsService.findPublicBySlug('organic-aloe-vera-gel');
      expect(await cache.get('catalog:products:slug:organic-aloe-vera-gel')).not.toBeNull();

      mockPrisma.product.findUnique.mockResolvedValueOnce(mockProductRow);
      mockPrisma.product.update.mockResolvedValueOnce({
        ...mockProductRow,
        status: 'ARCHIVED',
      });

      await productsService.archive(
        'prod-uuid-1',
        { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com' } as any,
      );

      expect(await cache.get('catalog:products:slug:organic-aloe-vera-gel')).toBeNull();
    });
  });

  describe('CategoriesService Caching & Invalidation Integration', () => {
    let cache: MemoryCacheProvider;
    let mockPrisma: any;
    let mockAudit: any;
    let categoriesService: CategoriesService;

    const mockCategoryRow = {
      id: 'cat-uuid-1',
      name: 'Skincare',
      slug: 'skincare',
      description: 'Natural skincare',
      parentId: null,
      sortOrder: 0,
      status: 'ACTIVE',
    };

    beforeEach(() => {
      cache = new MemoryCacheProvider(100);
      mockPrisma = {
        category: {
          findMany: vi.fn().mockResolvedValue([mockCategoryRow]),
          findUnique: vi.fn().mockResolvedValue(mockCategoryRow),
          create: vi.fn(),
          update: vi.fn(),
          count: vi.fn().mockResolvedValue(0),
        },
        product: {
          count: vi.fn().mockResolvedValue(0),
        },
      };
      mockAudit = {
        logEvent: vi.fn().mockResolvedValue(undefined),
      };

      categoriesService = new CategoriesService(
        mockPrisma as unknown as PrismaService,
        mockAudit as unknown as AuditService,
        cache,
      );
    });

    it('caches findAll(false) and findBySlug', async () => {
      const list1 = await categoriesService.findAll(false);
      expect(list1).toHaveLength(1);
      expect(mockPrisma.category.findMany).toHaveBeenCalledTimes(1);

      // Hit cache
      const list2 = await categoriesService.findAll(false);
      expect(list2).toEqual(list1);
      expect(mockPrisma.category.findMany).toHaveBeenCalledTimes(1);

      // Slug cache
      const cat1 = await categoriesService.findBySlug('skincare');
      expect(cat1.slug).toBe('skincare');
      const cat2 = await categoriesService.findBySlug('skincare');
      expect(cat2).toEqual(cat1);
      expect(mockPrisma.category.findUnique).toHaveBeenCalledTimes(1);
    });

    it('invalidates category cache and product list cache on category update', async () => {
      await categoriesService.findAll(false);
      await categoriesService.findBySlug('skincare');
      await cache.set('catalog:products:list:1:20:cat-uuid-1', 'cached-product-list');

      expect(await cache.get('catalog:categories:list')).not.toBeNull();
      expect(await cache.get('catalog:categories:slug:skincare')).not.toBeNull();
      expect(await cache.get('catalog:products:list:1:20:cat-uuid-1')).not.toBeNull();

      mockPrisma.category.findUnique.mockResolvedValueOnce(mockCategoryRow);
      mockPrisma.category.update.mockResolvedValueOnce({
        ...mockCategoryRow,
        name: 'Organic Skincare',
      });

      await categoriesService.update(
        'cat-uuid-1',
        { name: 'Organic Skincare' },
        { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com' } as any,
      );

      expect(await cache.get('catalog:categories:list')).toBeNull();
      expect(await cache.get('catalog:categories:slug:skincare')).toBeNull();
      expect(await cache.get('catalog:products:list:1:20:cat-uuid-1')).toBeNull();
    });
  });

  describe('HTTP Cache-Control Headers', () => {
    it('sets public Cache-Control headers on public products endpoints', async () => {
      const mockService = {
        findPublicProducts: vi.fn().mockResolvedValue({ data: [], total: 0 }),
        findPublicBySlug: vi.fn().mockResolvedValue({ id: 'p1', name: 'Product' }),
      } as unknown as ProductsService;

      const controller = new PublicProductsController(mockService);

      const headers: Record<string, string> = {};
      const mockRes = {
        setHeader: vi.fn((k: string, v: string) => {
          headers[k] = v;
        }),
      } as unknown as Response;

      await controller.findAll(mockRes, 1, 20);
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=60, stale-while-revalidate=30',
      );

      await controller.findBySlug(mockRes, 'test-slug');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=120, stale-while-revalidate=60',
      );
    });

    it('sets public Cache-Control headers on public categories endpoints', async () => {
      const mockService = {
        findAll: vi.fn().mockResolvedValue([]),
        findBySlug: vi.fn().mockResolvedValue({ id: 'c1', name: 'Category' }),
      } as unknown as CategoriesService;

      const controller = new PublicCategoriesController(mockService);

      const headers: Record<string, string> = {};
      const mockRes = {
        setHeader: vi.fn((k: string, v: string) => {
          headers[k] = v;
        }),
      } as unknown as Response;

      await controller.findAll(mockRes);
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=300, stale-while-revalidate=60',
      );

      await controller.findBySlug(mockRes, 'skincare');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=300, stale-while-revalidate=60',
      );
    });
  });

  describe('Authoritative Business Integrity (Non-Cacheable Guarantee)', () => {
    it('verifies cache keys are isolated with explicit domain prefixes', async () => {
      const cache = new MemoryCacheProvider(10);
      await cache.set('catalog:products:slug:prod-1', 'product-detail');
      await cache.set('catalog:categories:slug:cat-1', 'category-detail');

      // Prefix deletion of products does not affect categories
      await cache.deleteByPrefix('catalog:products:');
      expect(await cache.get('catalog:products:slug:prod-1')).toBeNull();
      expect(await cache.get('catalog:categories:slug:cat-1')).toBe('category-detail');
    });

    it('verifies that cache failure gracefully falls back to database without throwing', async () => {
      const faultyCache: MemoryCacheProvider = new MemoryCacheProvider();
      // Inject failure simulation into getOrSet
      vi.spyOn(faultyCache, 'get').mockRejectedValueOnce(new Error('Simulated memory store failure'));

      let dbHit = false;
      const result = await faultyCache.getOrSet(
        'key-with-error',
        async () => {
          dbHit = true;
          return { status: 'from-db' };
        },
        60,
      );

      expect(dbHit).toBe(true);
      expect(result).toEqual({ status: 'from-db' });
    });
  });
});
