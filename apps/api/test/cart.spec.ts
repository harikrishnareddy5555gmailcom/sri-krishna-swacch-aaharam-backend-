import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import {
  CartStatus,
  ProductStatus,
  ProductVariantStatus,
  AuditAction,
  AuditEntityType,
  DEFAULT_MAX_CART_ITEM_QUANTITY,
} from '@vishkaraa/types';
import { CartService, type CartActor } from '../src/cart/cart.service.js';

describe('CartService — Comprehensive Domain & Security Tests', () => {
  let mockPrisma: any;
  let mockAudit: any;
  let cartService: CartService;

  const mockActiveProduct = {
    id: 'prod-uuid-1',
    name: 'Cold Pressed Sesame Oil',
    slug: 'cold-pressed-sesame-oil',
    status: ProductStatus.ACTIVE,
    media: [{ url: 'https://cdn.vishkaraa.local/sesame.jpg', isPrimary: true, altText: 'Sesame Oil' }],
  };

  const mockActiveVariant = {
    id: 'var-uuid-1',
    productId: 'prod-uuid-1',
    name: '1 Litre',
    sku: 'SESAME-1L',
    price: 35000, // 350 INR in paise
    compareAtPrice: 40000,
    currency: 'INR',
    status: ProductVariantStatus.ACTIVE,
  };

  const mockActiveProduct2 = {
    id: 'prod-uuid-2',
    name: 'Cold Pressed Groundnut Oil',
    slug: 'cold-pressed-groundnut-oil',
    status: ProductStatus.ACTIVE,
    media: [],
  };

  const mockActiveVariant2 = {
    id: 'var-uuid-2',
    productId: 'prod-uuid-2',
    name: '500 ml',
    sku: 'GROUNDNUT-500ML',
    price: 18000, // 180 INR in paise
    compareAtPrice: null,
    currency: 'INR',
    status: ProductVariantStatus.ACTIVE,
  };

  beforeEach(() => {
    mockPrisma = {
      cart: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      cartItem: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      product: {
        findUnique: vi.fn(),
      },
      productVariant: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(async (cb: any) => {
        return cb(mockPrisma);
      }),
    };

    mockAudit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    cartService = new CartService(mockPrisma, mockAudit);
  });

  // ─── 1. Guest Cart Creation ────────────────────────────────────────────────
  it('1. creates guest cart with 256-bit cryptographically random token, hashed for storage', async () => {
    const rawToken = 'dummy-token';
    vi.spyOn(cartService, 'generateGuestToken').mockReturnValue(rawToken);

    mockPrisma.cart.findFirst.mockResolvedValue(null);
    mockPrisma.cart.create.mockImplementation((args: any) => ({
      id: 'cart-guest-1',
      userId: null,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      guestTokenHash: args.data.guestTokenHash,
      expiresAt: args.data.expiresAt,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const result = await cartService.getOrCreateCart({});

    expect(result.rawGuestToken).toBe(rawToken);
    expect(result.cart.guestToken).toBe(rawToken);
    expect(mockPrisma.cart.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CartStatus.ACTIVE,
          guestTokenHash: cartService.hashGuestToken(rawToken),
        }),
      }),
    );
  });

  // ─── 2. Guest Add Item ─────────────────────────────────────────────────────
  it('2. allows guest to add item with authoritative catalog price snapshot', async () => {
    const rawGuestToken = 'token-12345678901234567890123456789012';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    mockPrisma.product.findUnique.mockResolvedValue(mockActiveProduct);
    mockPrisma.productVariant.findUnique.mockResolvedValue(mockActiveVariant);

    const guestCart = {
      id: 'cart-guest-1',
      userId: null,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      guestTokenHash: guestHash,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.cart.findFirst.mockResolvedValue(guestCart);
    mockPrisma.cartItem.findUnique.mockResolvedValue(null); // Not existing yet

    const updatedCart = {
      ...guestCart,
      items: [
        {
          id: 'item-1',
          cartId: 'cart-guest-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 2,
          unitPrice: mockActiveVariant.price,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };
    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue(updatedCart);

    const result = await cartService.addItem(
      { guestToken: rawGuestToken },
      { productId: mockActiveProduct.id, productVariantId: mockActiveVariant.id, quantity: 2 },
    );

    expect(mockPrisma.cartItem.create).toHaveBeenCalledWith({
      data: {
        cartId: 'cart-guest-1',
        productId: mockActiveProduct.id,
        productVariantId: mockActiveVariant.id,
        quantity: 2,
        unitPrice: 35000, // authoritative price from variant
        currency: 'INR',
      },
    });
    expect(result.cart.totalItems).toBe(2);
    expect(result.cart.subtotal).toBe(70000); // 2 * 35000
  });

  // ─── 3. Guest Update Quantity ──────────────────────────────────────────────
  it('3. allows guest to update item quantity', async () => {
    const rawGuestToken = 'token-12345678901234567890123456789012';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    const guestCart = {
      id: 'cart-guest-1',
      guestTokenHash: guestHash,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockPrisma.cart.findFirst.mockResolvedValue(guestCart);

    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-guest-1',
      quantity: 1,
      unitPrice: 35000,
      productVariant: mockActiveVariant,
    });

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      ...guestCart,
      items: [
        {
          id: 'item-1',
          cartId: 'cart-guest-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 4,
          unitPrice: 35000,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const summary = await cartService.updateItemQuantity(
      { guestToken: rawGuestToken },
      'item-1',
      4,
    );

    expect(mockPrisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { quantity: 4, unitPrice: 35000 },
    });
    expect(summary.totalItems).toBe(4);
    expect(summary.subtotal).toBe(140000);
  });

  // ─── 4. Guest Remove Item ──────────────────────────────────────────────────
  it('4. allows guest to remove an item from cart', async () => {
    const rawGuestToken = 'token-12345678901234567890123456789012';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    const guestCart = {
      id: 'cart-guest-1',
      guestTokenHash: guestHash,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockPrisma.cart.findFirst.mockResolvedValue(guestCart);
    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-guest-1',
    });

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      ...guestCart,
      items: [],
    });

    const summary = await cartService.removeItem(
      { guestToken: rawGuestToken },
      'item-1',
    );

    expect(mockPrisma.cartItem.delete).toHaveBeenCalledWith({
      where: { id: 'item-1' },
    });
    expect(summary.items.length).toBe(0);
    expect(summary.totalItems).toBe(0);
  });

  // ─── 5. Guest Clear Cart ───────────────────────────────────────────────────
  it('5. allows guest to clear all items from cart', async () => {
    const rawGuestToken = 'token-12345678901234567890123456789012';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    const guestCart = {
      id: 'cart-guest-1',
      guestTokenHash: guestHash,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockPrisma.cart.findFirst.mockResolvedValue(guestCart);
    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      ...guestCart,
      items: [],
    });

    const summary = await cartService.clearCart({ guestToken: rawGuestToken });

    expect(mockPrisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { cartId: 'cart-guest-1' },
    });
    expect(summary.totalItems).toBe(0);
  });

  // ─── 6. Authenticated User Cart ────────────────────────────────────────────
  it('6. creates or retrieves an active cart bound to the authenticated user', async () => {
    const userId = 'user-uuid-1';
    mockPrisma.cart.findFirst.mockResolvedValue(null);
    mockPrisma.cart.create.mockResolvedValue({
      id: 'cart-user-1',
      userId,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await cartService.getOrCreateCart({ userId });

    expect(result.cart.id).toBe('cart-user-1');
    expect(mockPrisma.cart.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId,
          status: CartStatus.ACTIVE,
        }),
      }),
    );
  });

  // ─── 7. User cannot access another user's cart (IDOR) ──────────────────────
  it("7. prevents user from updating an item in another user's cart (IDOR protection)", async () => {
    const user1Id = 'user-uuid-1';
    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-user-1',
      userId: user1Id,
      status: CartStatus.ACTIVE,
    });

    // Item belongs to cart-user-2
    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'item-of-user-2',
      cartId: 'cart-user-2',
      productVariant: mockActiveVariant,
    });

    await expect(
      cartService.updateItemQuantity({ userId: user1Id }, 'item-of-user-2', 3),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── 8. Guest cannot access another guest cart (IDOR) ──────────────────────
  it("8. prevents a guest from accessing or updating another guest's cart item", async () => {
    const guest1Token = 'token-guest-1-12345678901234567890';
    const guest1Hash = cartService.hashGuestToken(guest1Token);

    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-guest-1',
      guestTokenHash: guest1Hash,
      status: CartStatus.ACTIVE,
    });

    // Item belongs to cart-guest-2
    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'item-of-guest-2',
      cartId: 'cart-guest-2',
    });

    await expect(
      cartService.removeItem({ guestToken: guest1Token }, 'item-of-guest-2'),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── 9. Invalid product rejected ───────────────────────────────────────────
  it('9. rejects adding item when productId does not exist', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(null);

    await expect(
      cartService.addItem(
        { userId: 'user-1' },
        { productId: 'non-existent-prod', productVariantId: 'var-1', quantity: 1 },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── 10. Invalid variant rejected ──────────────────────────────────────────
  it('10. rejects adding item when productVariantId does not exist', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(mockActiveProduct);
    mockPrisma.productVariant.findUnique.mockResolvedValue(null);

    await expect(
      cartService.addItem(
        { userId: 'user-1' },
        { productId: mockActiveProduct.id, productVariantId: 'non-existent-var', quantity: 1 },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── 11. Variant belonging to another product rejected ─────────────────────
  it('11. rejects variant when it belongs to a different product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(mockActiveProduct);
    mockPrisma.productVariant.findUnique.mockResolvedValue({
      ...mockActiveVariant,
      productId: 'different-product-id',
    });

    await expect(
      cartService.addItem(
        { userId: 'user-1' },
        { productId: mockActiveProduct.id, productVariantId: mockActiveVariant.id, quantity: 1 },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // ─── 12. Inactive product rejected ─────────────────────────────────────────
  it('12. rejects adding item when product status is not ACTIVE (e.g., DRAFT or ARCHIVED)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      ...mockActiveProduct,
      status: ProductStatus.DRAFT,
    });

    await expect(
      cartService.addItem(
        { userId: 'user-1' },
        { productId: mockActiveProduct.id, productVariantId: mockActiveVariant.id, quantity: 1 },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // ─── 13. Inactive variant rejected ─────────────────────────────────────────
  it('13. rejects adding item when variant status is not ACTIVE (e.g., DISCONTINUED)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(mockActiveProduct);
    mockPrisma.productVariant.findUnique.mockResolvedValue({
      ...mockActiveVariant,
      status: ProductVariantStatus.DISCONTINUED,
    });

    await expect(
      cartService.addItem(
        { userId: 'user-1' },
        { productId: mockActiveProduct.id, productVariantId: mockActiveVariant.id, quantity: 1 },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // ─── 14. Client-provided price ignored ─────────────────────────────────────
  it('14. ignores client-provided price and always takes authoritative catalog price snapshot', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(mockActiveProduct);
    mockPrisma.productVariant.findUnique.mockResolvedValue(mockActiveVariant); // price is 35000 paise

    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrisma.cartItem.findUnique.mockResolvedValue(null);

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      id: 'cart-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [
        {
          id: 'item-1',
          cartId: 'cart-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 1,
          unitPrice: mockActiveVariant.price,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Client maliciously passes arbitrary price in DTO (or extra fields)
    const maliciousDto: any = {
      productId: mockActiveProduct.id,
      productVariantId: mockActiveVariant.id,
      quantity: 1,
      price: 1, // Attempt to buy for 1 paisa
    };

    await cartService.addItem({ userId: 'user-1' }, maliciousDto);

    expect(mockPrisma.cartItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        unitPrice: 35000, // Took 35000 from authoritative variant, ignored 1
      }),
    });
  });

  // ─── 15. Negative quantity rejected ────────────────────────────────────────
  it('15. rejects negative quantities', () => {
    expect(() => cartService.validateQuantity(-1)).toThrow(BadRequestException);
    expect(() => cartService.validateQuantity(-10)).toThrow(BadRequestException);
  });

  // ─── 16. Zero quantity rejected ────────────────────────────────────────────
  it('16. rejects zero quantity', () => {
    expect(() => cartService.validateQuantity(0)).toThrow(BadRequestException);
  });

  // ─── 17. Excessive quantity rejected ───────────────────────────────────────
  it(`17. rejects quantity exceeding DEFAULT_MAX_CART_ITEM_QUANTITY (${DEFAULT_MAX_CART_ITEM_QUANTITY})`, () => {
    expect(() => cartService.validateQuantity(21)).toThrow(BadRequestException);
    expect(() => cartService.validateQuantity(100)).toThrow(BadRequestException);
  });

  // ─── 18. Duplicate variant handling ────────────────────────────────────────
  it('18. increments existing item quantity instead of creating duplicate row when variant is re-added', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(mockActiveProduct);
    mockPrisma.productVariant.findUnique.mockResolvedValue(mockActiveVariant);

    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Existing item already has quantity 2
    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'item-existing',
      cartId: 'cart-1',
      productId: mockActiveProduct.id,
      productVariantId: mockActiveVariant.id,
      quantity: 2,
      unitPrice: 35000,
    });

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      id: 'cart-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await cartService.addItem(
      { userId: 'user-1' },
      { productId: mockActiveProduct.id, productVariantId: mockActiveVariant.id, quantity: 3 },
    );

    // Updates existing row to 2 + 3 = 5
    expect(mockPrisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'item-existing' },
      data: {
        quantity: 5,
        unitPrice: 35000,
      },
    });
    expect(mockPrisma.cartItem.create).not.toHaveBeenCalled();
  });

  // ─── 19. Transaction safety ────────────────────────────────────────────────
  it('19. executes cart mutations within database transactions for concurrency safety', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(mockActiveProduct);
    mockPrisma.productVariant.findUnique.mockResolvedValue(mockActiveVariant);
    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrisma.cartItem.findUnique.mockResolvedValue(null);
    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      id: 'cart-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await cartService.addItem(
      { userId: 'user-1' },
      { productId: mockActiveProduct.id, productVariantId: mockActiveVariant.id, quantity: 1 },
    );

    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  // ─── 20. Guest-to-user merge ───────────────────────────────────────────────
  it('20. merges guest cart items into user cart upon login', async () => {
    const rawGuestToken = 'token-merge-12345678901234567890';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    mockPrisma.cart.findFirst
      .mockResolvedValueOnce({
        id: 'cart-guest-1',
        guestTokenHash: guestHash,
        status: CartStatus.ACTIVE,
        items: [
          {
            id: 'g-item-1',
            productId: mockActiveProduct.id,
            productVariantId: mockActiveVariant.id,
            quantity: 2,
            unitPrice: 35000,
            product: mockActiveProduct,
            productVariant: mockActiveVariant,
          },
        ],
      }) // guest cart lookup
      .mockResolvedValueOnce(null); // user cart lookup (creates new)

    mockPrisma.cart.create.mockResolvedValue({
      id: 'cart-user-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
    });

    mockPrisma.cartItem.findUnique.mockResolvedValue(null); // not existing in user cart

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      id: 'cart-user-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [
        {
          id: 'u-item-1',
          cartId: 'cart-user-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 2,
          unitPrice: 35000,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await cartService.mergeGuestCart('user-1', rawGuestToken);

    expect(result.mergedCount).toBe(1);
    expect(result.cart.totalItems).toBe(2);
    expect(mockPrisma.cart.update).toHaveBeenCalledWith({
      where: { id: 'cart-guest-1' },
      data: { status: CartStatus.MERGED },
    });
  });

  // ─── 21. Merge quantity combination ────────────────────────────────────────
  it('21. combines quantities for matching variants between guest and user cart', async () => {
    const rawGuestToken = 'token-merge-combine-12345678901234';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    mockPrisma.cart.findFirst
      .mockResolvedValueOnce({
        id: 'cart-guest-1',
        guestTokenHash: guestHash,
        status: CartStatus.ACTIVE,
        items: [
          {
            id: 'g-item-1',
            productId: mockActiveProduct.id,
            productVariantId: mockActiveVariant.id,
            quantity: 3,
            unitPrice: 35000,
            product: mockActiveProduct,
            productVariant: mockActiveVariant,
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'cart-user-1',
        userId: 'user-1',
        status: CartStatus.ACTIVE,
        items: [{ productVariantId: mockActiveVariant.id, quantity: 2 }],
      });

    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'u-item-1',
      cartId: 'cart-user-1',
      productVariantId: mockActiveVariant.id,
      quantity: 2,
    });

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      id: 'cart-user-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [
        {
          id: 'u-item-1',
          cartId: 'cart-user-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 5,
          unitPrice: 35000,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await cartService.mergeGuestCart('user-1', rawGuestToken);

    // 2 (existing) + 3 (guest) = 5
    expect(mockPrisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'u-item-1' },
      data: {
        quantity: 5,
        unitPrice: 35000,
      },
    });
    expect(result.cart.totalItems).toBe(5);
  });

  // ─── 22. Merge respects quantity limit ─────────────────────────────────────
  it(`22. caps combined merge quantity at ${DEFAULT_MAX_CART_ITEM_QUANTITY} with warning`, async () => {
    const rawGuestToken = 'token-merge-cap-12345678901234';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    mockPrisma.cart.findFirst
      .mockResolvedValueOnce({
        id: 'cart-guest-1',
        guestTokenHash: guestHash,
        status: CartStatus.ACTIVE,
        items: [
          {
            id: 'g-item-1',
            productId: mockActiveProduct.id,
            productVariantId: mockActiveVariant.id,
            quantity: 15,
            unitPrice: 35000,
            product: mockActiveProduct,
            productVariant: mockActiveVariant,
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'cart-user-1',
        userId: 'user-1',
        status: CartStatus.ACTIVE,
        items: [{ productVariantId: mockActiveVariant.id, quantity: 10 }],
      });

    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'u-item-1',
      cartId: 'cart-user-1',
      productVariantId: mockActiveVariant.id,
      quantity: 10,
    });

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      id: 'cart-user-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [
        {
          id: 'u-item-1',
          cartId: 'cart-user-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 20,
          unitPrice: 35000,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await cartService.mergeGuestCart('user-1', rawGuestToken);

    // 10 + 15 = 25, capped at 20
    expect(mockPrisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'u-item-1' },
      data: {
        quantity: 20,
        unitPrice: 35000,
      },
    });
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toContain('capped at the limit of 20');
  });

  // ─── 23. Merge invalidates/consumes guest cart ─────────────────────────────
  it('23. marks guest cart as MERGED to consume it', async () => {
    const rawGuestToken = 'token-merge-consume-12345678901234';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    mockPrisma.cart.findFirst
      .mockResolvedValueOnce({
        id: 'cart-guest-1',
        guestTokenHash: guestHash,
        status: CartStatus.ACTIVE,
        items: [],
      })
      .mockResolvedValueOnce({
        id: 'cart-user-1',
        userId: 'user-1',
        status: CartStatus.ACTIVE,
        items: [],
      });

    mockPrisma.cart.findUniqueOrThrow.mockResolvedValue({
      id: 'cart-user-1',
      userId: 'user-1',
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await cartService.mergeGuestCart('user-1', rawGuestToken);

    expect(mockPrisma.cart.update).toHaveBeenCalledWith({
      where: { id: 'cart-guest-1' },
      data: { status: CartStatus.MERGED },
    });
  });

  // ─── 24. Merge replay protection ───────────────────────────────────────────
  it('24. rejects replay merge attempts when guest cart is already MERGED and logs security alert', async () => {
    const rawGuestToken = 'token-replay-12345678901234';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-guest-1',
      guestTokenHash: guestHash,
      status: CartStatus.MERGED, // Already merged!
      items: [],
    });

    await expect(cartService.mergeGuestCart('user-1', rawGuestToken)).rejects.toThrow(
      ConflictException,
    );

    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CART_MERGE_FAILED,
        entityType: AuditEntityType.CART,
        entityId: 'cart-guest-1',
      }),
    );
  });

  // ─── 25. Cart subtotal correctness ─────────────────────────────────────────
  it('25. calculates subtotal correctly in integer minor units (paise) across multiple items', async () => {
    const rawToken = 'token-subtotal-12345678901234';
    const tokenHash = cartService.hashGuestToken(rawToken);

    // Item 1: 2 x 35000 = 70000 paise
    // Item 2: 3 x 18000 = 54000 paise
    // Total subtotal: 124000 paise (1240.00 INR)
    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-1',
      guestTokenHash: tokenHash,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [
        {
          id: 'item-1',
          cartId: 'cart-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 2,
          unitPrice: 35000,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'item-2',
          cartId: 'cart-1',
          productId: mockActiveProduct2.id,
          productVariantId: mockActiveVariant2.id,
          quantity: 3,
          unitPrice: 18000,
          currency: 'INR',
          product: mockActiveProduct2,
          productVariant: mockActiveVariant2,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await cartService.getOrCreateCart({ guestToken: rawToken });

    expect(result.cart.totalItems).toBe(5);
    expect(result.cart.subtotal).toBe(124000); // exactly 124000 paise
    expect(result.cart.items[0]!.lineTotal).toBe(70000);
    expect(result.cart.items[1]!.lineTotal).toBe(54000);
  });

  // ─── 26. Unavailable cart item behavior ────────────────────────────────────
  it('26. marks inactive items as isAvailable: false and excludes them from cart subtotal', async () => {
    const rawToken = 'token-unavail-12345678901234';
    const tokenHash = cartService.hashGuestToken(rawToken);

    // Product 1: ACTIVE (2 x 35000 = 70000 paise)
    // Product 2: now ARCHIVED (3 x 18000 = 54000 paise, but unavailable!)
    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-1',
      guestTokenHash: tokenHash,
      status: CartStatus.ACTIVE,
      currency: 'INR',
      items: [
        {
          id: 'item-1',
          cartId: 'cart-1',
          productId: mockActiveProduct.id,
          productVariantId: mockActiveVariant.id,
          quantity: 2,
          unitPrice: 35000,
          currency: 'INR',
          product: mockActiveProduct,
          productVariant: mockActiveVariant,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'item-2',
          cartId: 'cart-1',
          productId: mockActiveProduct2.id,
          productVariantId: mockActiveVariant2.id,
          quantity: 3,
          unitPrice: 18000,
          currency: 'INR',
          product: { ...mockActiveProduct2, status: ProductStatus.ARCHIVED },
          productVariant: mockActiveVariant2,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await cartService.getOrCreateCart({ guestToken: rawToken });

    expect(result.cart.items[0]!.isAvailable).toBe(true);
    expect(result.cart.items[1]!.isAvailable).toBe(false); // Flagged unavailable!
    // Subtotal only sums available item 1 (70000)
    expect(result.cart.subtotal).toBe(70000);
  });

  // ─── 27. IDOR Protection (cannot merge another user's cart) ────────────────
  it("27. prevents merging a cart belonging to a different user and emits security audit", async () => {
    const rawGuestToken = 'token-idor-12345678901234';
    const guestHash = cartService.hashGuestToken(rawGuestToken);

    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-owned-by-user-2',
      userId: 'user-2', // Already owned by user-2!
      guestTokenHash: guestHash,
      status: CartStatus.ACTIVE,
      items: [],
    });

    await expect(cartService.mergeGuestCart('user-1', rawGuestToken)).rejects.toThrow(
      ForbiddenException,
    );

    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CART_SECURITY_VIOLATION,
        entityType: AuditEntityType.CART,
        entityId: 'cart-owned-by-user-2',
      }),
    );
  });

  // ─── 28. Authorization Boundaries (Admin has no backdoor to user cart) ─────
  it('28. verifies admin cannot access arbitrary user carts through customer cart endpoints', async () => {
    const adminActor: CartActor = {
      userId: 'admin-1',
      userRole: 'ADMIN',
    };

    mockPrisma.cart.findFirst.mockResolvedValue({
      id: 'cart-admin-1',
      userId: 'admin-1',
      status: CartStatus.ACTIVE,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // An item belonging to a regular customer user-999
    mockPrisma.cartItem.findUnique.mockResolvedValue({
      id: 'item-customer-99',
      cartId: 'cart-customer-99',
    });

    // Admin attempting to remove customer's item is rejected
    await expect(
      cartService.removeItem(adminActor, 'item-customer-99'),
    ).rejects.toThrow(NotFoundException);
  });
});
