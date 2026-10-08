import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import {
  UserRole,
  ProductStatus,
  ProductVariantStatus,
  CheckoutStatus,
  CheckoutIssueCode,
  AuditAction,
  DEFAULT_MAX_CART_ITEM_QUANTITY,
} from '@vishkaraa/types';
import { PaymentStatus, ReservationStatus } from '@prisma/client';
import { CheckoutService } from '../src/checkout/checkout.service.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';
import { OrderService } from '../src/orders/orders.service.js';

describe('Phase 20D.8.5A — Backend Buy Now Checkout Support', () => {
  let checkoutService: CheckoutService;
  let orderService: OrderService;
  let mockPrisma: any;
  let mockFeatures: any;
  let mockAudit: any;
  let mockInventory: any;

  const regularUser: MinimalUser = {
    id: 'user-uuid-1',
    role: UserRole.USER,
    email: 'user1@vishkaraa.local',
  };

  const otherUser: MinimalUser = {
    id: 'user-uuid-2',
    role: UserRole.USER,
    email: 'user2@vishkaraa.local',
  };

  const mockProduct = {
    id: 'prod-oil-1',
    name: 'Cold-Pressed Sesame Oil',
    slug: 'cold-pressed-sesame-oil',
    status: ProductStatus.ACTIVE,
    media: [
      {
        id: 'media-1',
        url: 'https://images.vishkaraa.local/sesame-500ml.jpg',
        isPrimary: true,
      },
    ],
  };

  const mockVariant = {
    id: 'var-sesame-500ml',
    productId: 'prod-oil-1',
    name: '500ml Glass Bottle',
    sku: 'SESAME-500ML',
    price: 35000, // ₹350.00
    currency: 'INR',
    status: ProductVariantStatus.ACTIVE,
  };

  const mockOtherProduct = {
    id: 'prod-oil-2',
    name: 'Cold-Pressed Groundnut Oil',
    slug: 'cold-pressed-groundnut-oil',
    status: ProductStatus.ACTIVE,
    media: [],
  };

  const mockCartItem = {
    id: 'cart-item-1',
    cartId: 'cart-persistent-1',
    productId: 'prod-oil-2',
    productVariantId: 'var-groundnut-1L',
    quantity: 3,
    unitPrice: 42000,
    currency: 'INR',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockActiveCart = {
    id: 'cart-persistent-1',
    userId: regularUser.id,
    status: 'ACTIVE',
    currency: 'INR',
    items: [mockCartItem],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockPrisma = {
      cart: {
        findFirst: vi.fn().mockResolvedValue(mockActiveCart),
      },
      cartItem: {
        findUnique: vi.fn().mockResolvedValue(mockCartItem),
        delete: vi.fn().mockResolvedValue(mockCartItem),
        update: vi.fn().mockResolvedValue(mockCartItem),
      },
      product: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === 'prod-oil-1') return mockProduct;
          if (where.id === 'prod-oil-2') return mockOtherProduct;
          return null;
        }),
        findMany: vi.fn().mockResolvedValue([mockProduct, mockOtherProduct]),
      },
      productVariant: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === 'var-sesame-500ml') return mockVariant;
          if (where.id === 'var-groundnut-1L') {
            return {
              id: 'var-groundnut-1L',
              productId: 'prod-oil-2',
              name: '1L',
              sku: 'GROUNDNUT-1L',
              price: 42000,
              currency: 'INR',
              status: ProductVariantStatus.ACTIVE,
            };
          }
          if (where.id === 'var-other-prod') {
            return {
              id: 'var-other-prod',
              productId: 'prod-oil-2', // belongs to different product
              name: '1L',
              sku: 'GROUNDNUT-1L',
              price: 42000,
              currency: 'INR',
              status: ProductVariantStatus.ACTIVE,
            };
          }
          return null;
        }),
        findMany: vi.fn().mockImplementation(async () => [
          mockVariant,
          {
            id: 'var-groundnut-1L',
            productId: 'prod-oil-2',
            name: '1L',
            sku: 'GROUNDNUT-1L',
            price: 42000,
            currency: 'INR',
            status: ProductVariantStatus.ACTIVE,
          },
        ]),
      },
      checkoutSession: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockImplementation(async ({ data }: any) => ({
          id: 'session-buynow-1',
          ...data,
          items: data.items.create.map((ci: any, idx: number) => ({
            id: `snap-${idx + 1}`,
            checkoutSessionId: 'session-buynow-1',
            ...ci,
            createdAt: new Date(),
          })),
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        update: vi.fn().mockImplementation(async ({ data, where }: any) => ({
          id: where.id,
          userId: regularUser.id,
          cartId: null,
          status: CheckoutStatus.ACTIVE,
          subtotal: 35000,
          currency: 'INR',
          expiresAt: new Date(Date.now() + 1800000),
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
          ...data,
        })),
      },
      paymentAttempt: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      inventoryReservation: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'res-1',
            checkoutSessionId: 'session-buynow-1',
            variantId: 'var-sesame-500ml',
            quantity: 1,
            status: ReservationStatus.PENDING,
          },
        ]),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => ({
          id: 'order-1',
          orderNumber: 'VN-202610-BN1234',
          userId: regularUser.id,
          checkoutSessionId: 'session-bn-order',
          paymentAttemptId: 'attempt-bn-1',
          status: 'CONFIRMED',
          subtotal: 35000,
          tax: 0,
          discount: 0,
          totalAmount: 35000,
          currency: 'INR',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
          paymentAttempt: {},
        })),
        create: vi.fn().mockImplementation(({ data }: any) => ({
          id: 'order-1',
          orderNumber: 'VN-202610-BN1234',
          ...data,
          createdAt: new Date(),
        })),
      },
      orderItem: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      $transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockPrisma)),
    };

    mockFeatures = {
      isFeatureEnabled: vi.fn().mockResolvedValue(true),
    };

    mockAudit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    mockInventory = {
      getBalance: vi.fn().mockResolvedValue({
        available: 50,
        reserved: 0,
        total: 50,
      }),
      reserveStock: vi.fn().mockResolvedValue(undefined),
      releaseReservation: vi.fn().mockResolvedValue(undefined),
      commitReservation: vi.fn().mockResolvedValue(undefined),
    };

    checkoutService = new CheckoutService(
      mockPrisma,
      mockFeatures,
      mockAudit,
      mockInventory,
    );

    orderService = new OrderService(
      mockPrisma,
      mockInventory,
    );
  });

  // 1 & 2. Valid Buy Now creates a session with cartId: null and exactly requested variant/quantity
  it('1 & 2: creates an authoritative CheckoutSession with cartId: null containing only the requested item', async () => {
    const session = await checkoutService.initializeCheckout(
      regularUser,
      'idemp-bn-1',
      undefined,
      {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 2,
      },
    );

    expect(session).toBeDefined();
    expect(session.id).toBe('session-buynow-1');
    expect(session.userId).toBe(regularUser.id);
    expect(session.cartId).toBeNull();
    expect(session.totalItems).toBe(2);
    expect(session.subtotal).toBe(70000); // 2 * 35000 paise (authoritative calculation)
    expect(session.currency).toBe('INR');
    expect(session.isValid).toBe(true);
    expect(session.issues).toHaveLength(0);
    expect(session.items).toHaveLength(1);
    expect(session.items[0]).toMatchObject({
      productId: 'prod-oil-1',
      productVariantId: 'var-sesame-500ml',
      productName: 'Cold-Pressed Sesame Oil',
      variantName: '500ml Glass Bottle',
      productSku: 'SESAME-500ML',
      quantity: 2,
      unitPrice: 35000,
      lineTotal: 70000,
      primaryImageUrl: 'https://images.vishkaraa.local/sesame-500ml.jpg',
    });

    // Stock reservation occurred
    expect(mockInventory.reserveStock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: 'session-buynow-1',
        items: [{ variantId: 'var-sesame-500ml', quantity: 2 }],
      }),
      expect.anything(),
    );
  });

  // 3. Existing cart items and quantities remain completely untouched
  it('3: does not query, modify, or merge the customer existing active cart during Buy Now', async () => {
    await checkoutService.initializeCheckout(
      regularUser,
      undefined,
      undefined,
      {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 1,
      },
    );

    // prisma.cart.findFirst was NOT called for Buy Now initialization
    expect(mockPrisma.cart.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.cartItem.delete).not.toHaveBeenCalled();
    expect(mockPrisma.cartItem.update).not.toHaveBeenCalled();
  });

  // 4. Client-supplied price or total manipulation is rejected or ignored
  it('4: ignores client-side pricing and computes lineTotal and subtotal strictly from database', async () => {
    const maliciousInput: any = {
      productId: 'prod-oil-1',
      productVariantId: 'var-sesame-500ml',
      quantity: 1,
      unitPrice: 100, // Malicious 1 rupee attempt
      subtotal: 100,
      price: 100,
    };

    const session = await checkoutService.initializeCheckout(
      regularUser,
      undefined,
      undefined,
      maliciousInput,
    );

    // Authoritative unit price from mockVariant (35000) is enforced
    expect(session.subtotal).toBe(35000);
    expect(session.items[0].unitPrice).toBe(35000);
    expect(session.items[0].lineTotal).toBe(35000);
  });

  // 5. Inactive product is rejected
  it('5: rejects Buy Now with PRODUCT_UNAVAILABLE if product is inactive or deleted', async () => {
    mockPrisma.product.findUnique.mockResolvedValueOnce({
      ...mockProduct,
      status: ProductStatus.DRAFT,
    });

    const session = await checkoutService.initializeCheckout(
      regularUser,
      undefined,
      undefined,
      {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 1,
      },
    );

    expect(session.isValid).toBe(false);
    expect(session.status).toBe(CheckoutStatus.CANCELLED);
    expect(session.issues).toHaveLength(1);
    expect(session.issues[0].code).toBe(CheckoutIssueCode.PRODUCT_UNAVAILABLE);
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 6. Inactive variant is rejected
  it('6: rejects Buy Now with VARIANT_UNAVAILABLE if variant is inactive or archived', async () => {
    mockPrisma.productVariant.findUnique.mockResolvedValueOnce({
      ...mockVariant,
      status: ProductVariantStatus.INACTIVE,
    });

    const session = await checkoutService.initializeCheckout(
      regularUser,
      undefined,
      undefined,
      {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 1,
      },
    );

    expect(session.isValid).toBe(false);
    expect(session.issues[0].code).toBe(CheckoutIssueCode.VARIANT_UNAVAILABLE);
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 7. Variant belonging to another product is rejected
  it('7: rejects Buy Now with VARIANT_MISMATCH if variant belongs to another product', async () => {
    const session = await checkoutService.initializeCheckout(
      regularUser,
      undefined,
      undefined,
      {
        productId: 'prod-oil-1', // Sesame Oil
        productVariantId: 'var-other-prod', // Variant belongs to Groundnut Oil
        quantity: 1,
      },
    );

    expect(session.isValid).toBe(false);
    expect(session.issues[0].code).toBe(CheckoutIssueCode.VARIANT_MISMATCH);
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 8. Invalid quantity and malformed nested input are rejected
  it('8: throws BadRequestException for non-integer, zero, negative, or excessive quantities', async () => {
    await expect(
      checkoutService.initializeCheckout(regularUser, undefined, undefined, {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 0,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      checkoutService.initializeCheckout(regularUser, undefined, undefined, {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: -2,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      checkoutService.initializeCheckout(regularUser, undefined, undefined, {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 1.5 as any,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      checkoutService.initializeCheckout(regularUser, undefined, undefined, {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: DEFAULT_MAX_CART_ITEM_QUANTITY + 1,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 9. Insufficient stock is rejected
  it('9: rejects Buy Now with INSUFFICIENT_STOCK if requested quantity exceeds available stock', async () => {
    mockInventory.getBalance.mockResolvedValueOnce({
      available: 2,
      reserved: 0,
      total: 2,
    });

    const session = await checkoutService.initializeCheckout(
      regularUser,
      undefined,
      undefined,
      {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 5,
      },
    );

    expect(session.isValid).toBe(false);
    expect(session.issues[0].code).toBe(CheckoutIssueCode.INSUFFICIENT_STOCK);
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 10. Buy Now revalidation succeeds even when customer has a different non-empty active cart
  it('10: revalidates Buy Now session successfully without checking or failing on customer active cart', async () => {
    const mockBuyNowSession = {
      id: 'session-bn-active',
      userId: regularUser.id,
      cartId: null, // Buy Now session
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 35000,
      expiresAt: new Date(Date.now() + 600000),
      createdAt: new Date(),
      updatedAt: new Date(),
      shippingAddress: null,
      items: [
        {
          id: 'snap-1',
          checkoutSessionId: 'session-bn-active',
          productId: 'prod-oil-1',
          productVariantId: 'var-sesame-500ml',
          productName: 'Cold-Pressed Sesame Oil',
          variantName: '500ml Glass Bottle',
          productSku: 'SESAME-500ML',
          quantity: 1,
          unitPrice: 35000,
          lineTotal: 35000,
          currency: 'INR',
          primaryImageUrl: null,
          createdAt: new Date(),
        },
      ],
    };

    mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockBuyNowSession);

    // Customer has a completely different cart (3x Groundnut Oil)
    mockPrisma.cart.findFirst.mockResolvedValueOnce(mockActiveCart);

    const revalidation = await checkoutService.revalidateCheckoutSession(
      'session-bn-active',
      regularUser,
    );

    expect(revalidation.isValid).toBe(true);
    expect(revalidation.issues).toHaveLength(0);
    // Verified: cart.findFirst was NOT called because session.cartId is null
    expect(mockPrisma.cart.findFirst).not.toHaveBeenCalled();
  });

  // 11. Buy Now revalidation still rejects changed price, unavailable variant, or expired session
  it('11: revalidation still detects PRICE_CHANGED on Buy Now sessions when catalog price updates', async () => {
    const mockBuyNowSession = {
      id: 'session-bn-pricecheck',
      userId: regularUser.id,
      cartId: null,
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 35000,
      expiresAt: new Date(Date.now() + 600000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'snap-1',
          checkoutSessionId: 'session-bn-pricecheck',
          productId: 'prod-oil-1',
          productVariantId: 'var-sesame-500ml',
          productName: 'Cold-Pressed Sesame Oil',
          variantName: '500ml Glass Bottle',
          productSku: 'SESAME-500ML',
          quantity: 1,
          unitPrice: 35000, // Captured at 350 INR
          lineTotal: 35000,
          currency: 'INR',
          primaryImageUrl: null,
          createdAt: new Date(),
        },
      ],
    };

    mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockBuyNowSession);

    // Catalog price was updated to 380 INR
    mockPrisma.productVariant.findMany.mockResolvedValueOnce([
      {
        ...mockVariant,
        price: 38000,
      },
    ]);

    const revalidation = await checkoutService.revalidateCheckoutSession(
      'session-bn-pricecheck',
      regularUser,
    );

    expect(revalidation.isValid).toBe(false);
    expect(revalidation.issues).toContainEqual(
      expect.objectContaining({
        code: CheckoutIssueCode.PRICE_CHANGED,
        previousPrice: 35000,
        currentPrice: 38000,
      }),
    );
  });

  // 12. Cart-based checkout retains its existing cart-parity protection
  it('12: retains CART_CHANGED revalidation detection on normal cart-based sessions', async () => {
    const mockCartSession = {
      id: 'session-cart-parity',
      userId: regularUser.id,
      cartId: 'cart-persistent-1', // Non-null cartId
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 70000,
      expiresAt: new Date(Date.now() + 600000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'snap-1',
          checkoutSessionId: 'session-cart-parity',
          productId: 'prod-oil-1',
          productVariantId: 'var-sesame-500ml',
          productName: 'Cold-Pressed Sesame Oil',
          variantName: '500ml Glass Bottle',
          productSku: 'SESAME-500ML',
          quantity: 2,
          unitPrice: 35000,
          lineTotal: 70000,
          currency: 'INR',
          primaryImageUrl: null,
          createdAt: new Date(),
        },
      ],
    };

    mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockCartSession);

    // Active cart items changed since checkout was created
    mockPrisma.cart.findFirst.mockResolvedValueOnce({
      ...mockActiveCart,
      items: [], // Cart emptied
    });

    const revalidation = await checkoutService.revalidateCheckoutSession(
      'session-cart-parity',
      regularUser,
    );

    expect(revalidation.isValid).toBe(false);
    expect(revalidation.issues).toContainEqual(
      expect.objectContaining({
        code: CheckoutIssueCode.CART_CHANGED,
      }),
    );
  });

  // 13. cartId: null order finalization does not clear or modify customer's cart
  it('13: skips cart-item cleanup during order finalization when cartId is null', async () => {
    const mockAttempt = {
      id: 'attempt-bn-1',
      userId: regularUser.id,
      checkoutSessionId: 'session-bn-order',
      amount: 35000,
      currency: 'INR',
      status: PaymentStatus.CAPTURED,
      provider: 'RAZORPAY',
      providerOrderId: 'order_rzp_1',
      providerPaymentId: 'pay_rzp_1',
      idempotencyKey: 'idemp-bn-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      checkoutSession: {
        id: 'session-bn-order',
        userId: regularUser.id,
        cartId: null, // Buy Now session
        status: CheckoutStatus.ACTIVE,
        currency: 'INR',
        subtotal: 35000,
        shippingName: 'Arjun Das',
        shippingPhone: '+919876543210',
        shippingLine1: '12 Vaagai Street',
        shippingCity: 'Madurai',
        shippingState: 'Tamil Nadu',
        shippingPostalCode: '625001',
        shippingCountry: 'IN',
        items: [
          {
            id: 'snap-1',
            checkoutSessionId: 'session-bn-order',
            productId: 'prod-oil-1',
            productVariantId: 'var-sesame-500ml',
            productName: 'Cold-Pressed Sesame Oil',
            variantName: '500ml Glass Bottle',
            productSku: 'SESAME-500ML',
            quantity: 1,
            unitPrice: 35000,
            lineTotal: 35000,
            currency: 'INR',
            primaryImageUrl: null,
            createdAt: new Date(),
          },
        ],
      },
    };

    mockPrisma.paymentAttempt.findUnique.mockResolvedValueOnce(mockAttempt);

    const order = await orderService.finalizeFromPayment('attempt-bn-1');

    expect(order).toBeDefined();
    expect(order.checkoutSessionId).toBe('session-bn-order');
    // Crucial check: cartItem find/update/delete was completely bypassed
    expect(mockPrisma.cartItem.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.cartItem.delete).not.toHaveBeenCalled();
    expect(mockPrisma.cartItem.update).not.toHaveBeenCalled();
  });

  // 14. Duplicate initialization follows idempotency rules
  it('14: returns existing session idempotently when identical idempotencyKey is supplied', async () => {
    const existingSession = {
      id: 'session-idemp-bn',
      userId: regularUser.id,
      cartId: null,
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 35000,
      totalItems: 1,
      idempotencyKey: 'client-key-123',
      expiresAt: new Date(Date.now() + 600000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'snap-1',
          checkoutSessionId: 'session-idemp-bn',
          productId: 'prod-oil-1',
          productVariantId: 'var-sesame-500ml',
          productName: 'Cold-Pressed Sesame Oil',
          variantName: '500ml Glass Bottle',
          productSku: 'SESAME-500ML',
          quantity: 1,
          unitPrice: 35000,
          lineTotal: 35000,
          currency: 'INR',
          primaryImageUrl: null,
          createdAt: new Date(),
        },
      ],
    };

    mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(existingSession);

    const session = await checkoutService.initializeCheckout(
      regularUser,
      'client-key-123',
      undefined,
      {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 1,
      },
    );

    expect(session.id).toBe('session-idemp-bn');
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 15. Cart checkout and Buy Now sessions can coexist without corrupting either session or reservations
  it('15: active cart checkout session and Buy Now session coexist without cancellation conflicts', async () => {
    // 1. User initializes regular cart checkout
    mockPrisma.checkoutSession.findFirst.mockResolvedValueOnce(null); // No prior session for cart
    mockPrisma.checkoutSession.create.mockResolvedValueOnce({
      id: 'session-cart-active',
      userId: regularUser.id,
      cartId: 'cart-persistent-1',
      status: CheckoutStatus.ACTIVE,
      subtotal: 70000,
      currency: 'INR',
      expiresAt: new Date(Date.now() + 1800000),
      items: [
        {
          id: 'snap-cart-1',
          checkoutSessionId: 'session-cart-active',
          productId: 'prod-oil-2',
          productVariantId: 'var-groundnut-1L',
          quantity: 3,
          unitPrice: 42000,
          lineTotal: 126000,
          currency: 'INR',
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const cartSession = await checkoutService.initializeCheckout(regularUser);
    expect(cartSession.id).toBe('session-cart-active');
    expect(cartSession.cartId).toBe('cart-persistent-1');

    // 2. User then clicks Buy Now for Sesame Oil in another tab
    // mockPrisma.checkoutSession.findFirst searches for active Buy Now session (cartId: null)
    mockPrisma.checkoutSession.findFirst.mockResolvedValueOnce(null); // No prior Buy Now session
    mockPrisma.checkoutSession.create.mockResolvedValueOnce({
      id: 'session-buynow-active',
      userId: regularUser.id,
      cartId: null, // Buy Now session
      status: CheckoutStatus.ACTIVE,
      subtotal: 35000,
      currency: 'INR',
      expiresAt: new Date(Date.now() + 1800000),
      items: [
        {
          id: 'snap-bn-1',
          checkoutSessionId: 'session-buynow-active',
          productId: 'prod-oil-1',
          productVariantId: 'var-sesame-500ml',
          quantity: 1,
          unitPrice: 35000,
          lineTotal: 35000,
          currency: 'INR',
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const buyNowSession = await checkoutService.initializeCheckout(
      regularUser,
      undefined,
      undefined,
      {
        productId: 'prod-oil-1',
        productVariantId: 'var-sesame-500ml',
        quantity: 1,
      },
    );

    expect(buyNowSession.id).toBe('session-buynow-active');
    expect(buyNowSession.cartId).toBeNull();

    // Verify session-cart-active was NOT cancelled when Buy Now was initialized
    expect(mockPrisma.checkoutSession.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'session-cart-active' },
        data: { status: CheckoutStatus.CANCELLED },
      }),
    );
  });
});
