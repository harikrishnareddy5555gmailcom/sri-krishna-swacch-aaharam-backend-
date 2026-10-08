import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryCacheProvider } from '../src/common/cache/memory-cache.provider.js';
import { ProductsService } from '../src/catalog/products.service.js';
import { ProductStatus, ProductVariantStatus } from '@vishkaraa/types';

describe('Multi-Variant Package Size & Variant-Specific Media Engine', () => {
  let cache: MemoryCacheProvider;
  let mockPrisma: any;
  let mockAudit: any;
  let service: ProductsService;

  const mockAdminUser = {
    id: 'user-admin-1',
    role: 'ADMIN',
    email: 'admin@vishkaraa.com',
  };

  beforeEach(() => {
    cache = new MemoryCacheProvider(100);
    mockAudit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
    };

    mockPrisma = {
      category: {
        findUnique: vi.fn().mockResolvedValue({ id: 'cat-oils-1', name: 'Cooking Oils' }),
      },
      product: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      productVariant: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
      },
      productMedia: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
      inventoryItem: {
        findUnique: vi.fn(),
        create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: `inv-${Date.now()}`, ...data })),
        update: vi.fn(),
      },
      inventoryMovement: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockPrisma)),
    };

    service = new ProductsService(mockPrisma as any, mockAudit as any, cache);
  });

  it('creates parent product with multiple package size variants and container photos in a single atomic transaction', async () => {
    const createdProduct = {
      id: 'prod-oil-1',
      name: 'Pure Groundnut Oil',
      slug: 'pure-groundnut-oil',
      status: ProductStatus.ACTIVE,
      images: ['https://cdn.vishkaraa.com/shared-infographic.jpg'],
      variants: [],
    };

    mockPrisma.product.findUnique.mockResolvedValue(null); // slug is unique
    mockPrisma.product.create.mockResolvedValue(createdProduct);
    mockPrisma.productVariant.findMany.mockResolvedValue([]);

    let varCounter = 0;
    mockPrisma.productVariant.create.mockImplementation(async ({ data }: any) => {
      varCounter++;
      return {
        id: `var-${varCounter}`,
        ...data,
      };
    });

    const dto = {
      name: 'Pure Groundnut Oil',
      slug: 'pure-groundnut-oil',
      categoryId: 'cat-oils-1',
      images: ['https://cdn.vishkaraa.com/shared-infographic.jpg'],
      variants: [
        {
          title: 'Pure Groundnut Oil - 500 ml',
          packageSize: '500 ml',
          price: 25000,
          compareAtPrice: 30000,
          sku: 'PGO-500ML',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-500ml-bottle.jpg',
          isDefault: true,
          stock: 100,
        },
        {
          title: 'Pure Groundnut Oil - 1 L',
          packageSize: '1 L',
          price: 48000,
          compareAtPrice: 55000,
          sku: 'PGO-1L',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-1l-bottle.jpg',
          isDefault: false,
          stock: 50,
        },
        {
          title: 'Pure Groundnut Oil - 15 kg Tin',
          packageSize: '15 kg Tin',
          price: 650000,
          sku: 'PGO-15KG',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-15kg-tin.jpg',
          isDefault: false,
          stock: 10,
        },
      ],
    };

    const result = await service.create(dto as any, mockAdminUser as any);

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Pure Groundnut Oil',
          images: ['https://cdn.vishkaraa.com/shared-infographic.jpg'],
        }),
      }),
    );

    // Verifies all 3 variants created with respective package sizes and container photos
    expect(mockPrisma.productVariant.create).toHaveBeenCalledTimes(3);
    expect(mockPrisma.productVariant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          packageSize: '500 ml',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-500ml-bottle.jpg',
          isDefault: true,
        }),
      }),
    );
    expect(mockPrisma.productVariant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          packageSize: '1 L',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-1l-bottle.jpg',
          isDefault: false,
        }),
      }),
    );
    expect(mockPrisma.productVariant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          packageSize: '15 kg Tin',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-15kg-tin.jpg',
          isDefault: false,
        }),
      }),
    );

    // Verifies inventory items created for all 3 package options
    expect(mockPrisma.inventoryItem.create).toHaveBeenCalledTimes(3);
    expect(mockPrisma.inventoryMovement.create).toHaveBeenCalledTimes(3);
  });

  it('updates product and synchronizes variants atomically with inventory movement entries', async () => {
    const existingProduct = {
      id: 'prod-oil-1',
      name: 'Pure Groundnut Oil',
      slug: 'pure-groundnut-oil',
      variants: [
        {
          id: 'var-1',
          productId: 'prod-oil-1',
          packageSize: '500 ml',
          sku: 'PGO-500ML',
          status: ProductVariantStatus.ACTIVE,
          inventoryItem: {
            id: 'inv-1',
            variantId: 'var-1',
            onHand: 100,
            reserved: 0,
            committed: 0,
            version: 1,
          },
        },
        {
          id: 'var-2',
          productId: 'prod-oil-1',
          packageSize: '1 L',
          sku: 'PGO-1L',
          status: ProductVariantStatus.ACTIVE,
          inventoryItem: null,
        },
      ],
    };

    mockPrisma.product.findUnique.mockResolvedValue(existingProduct);
    mockPrisma.product.update.mockResolvedValue({ ...existingProduct, name: 'Cold-Pressed Groundnut Oil' });
    mockPrisma.productVariant.findMany.mockResolvedValue(existingProduct.variants);
    mockPrisma.productVariant.create.mockImplementation(async ({ data }: any) => ({ id: 'var-new-5l', ...data }));

    const updateDto = {
      name: 'Cold-Pressed Groundnut Oil',
      variants: [
        // Update existing var-1: change stock from 100 to 120 (+20 delta)
        {
          id: 'var-1',
          title: 'Cold-Pressed Groundnut Oil - 500 ml',
          packageSize: '500 ml',
          price: 26000,
          sku: 'PGO-500ML',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-500ml-new.jpg',
          stock: 120,
        },
        // Add new package size: 5 L Can
        {
          title: 'Cold-Pressed Groundnut Oil - 5 L Can',
          packageSize: '5 L Can',
          price: 220000,
          sku: 'PGO-5L',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-5l-can.jpg',
          stock: 25,
        },
      ],
      // var-2 is omitted, so it should be deactivated
    };

    await service.update('prod-oil-1', updateDto as any, mockAdminUser as any);

    // 1. Existing var-1 updated
    expect(mockPrisma.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'var-1' },
        data: expect.objectContaining({
          imageUrl: 'https://cdn.vishkaraa.com/pgo-500ml-new.jpg',
          price: 26000,
        }),
      }),
    );

    // 2. Omitted var-2 marked DISCONTINUED / inactive
    expect(mockPrisma.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'var-2' },
        data: expect.objectContaining({
          status: ProductVariantStatus.DISCONTINUED,
        }),
      }),
    );

    // 3. New variant created
    expect(mockPrisma.productVariant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          packageSize: '5 L Can',
          imageUrl: 'https://cdn.vishkaraa.com/pgo-5l-can.jpg',
        }),
      }),
    );

    // 4. Inventory delta recorded on inventoryMovement
    expect(mockPrisma.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inventoryItemId: 'inv-1',
          quantityDelta: 20, // 120 - 100 = +20
          type: 'ADMIN_ADJUSTMENT_INCREASE',
          reason: 'Admin package size inventory update for 500 ml',
        }),
      }),
    );
  });
});
