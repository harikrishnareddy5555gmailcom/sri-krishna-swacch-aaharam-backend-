import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  UserRole,
  ProductStatus,
  ProductVariantStatus,
  CheckoutStatus,
  CheckoutIssueCode,
  AuditAction,
  AuditEntityType,
  FeatureKey,
} from '@vishkaraa/types';
import { Prisma, PaymentStatus } from '@prisma/client';
import { CheckoutService } from '../src/checkout/checkout.service.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('CheckoutService — Authoritative Checkout & Snapshot Gate', () => {
  let checkoutService: CheckoutService;
  let mockPrisma: any;
  let mockFeatures: any;
  let mockAudit: any;

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

  const adminUser: MinimalUser = {
    id: 'admin-uuid-1',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  const mockProduct = {
    id: 'prod-1',
    name: 'Organic Virgin Coconut Oil',
    slug: 'organic-virgin-coconut-oil',
    status: ProductStatus.ACTIVE,
    media: [
      {
        id: 'media-1',
        url: 'https://images.unsplash.com/photo-1',
        isPrimary: true,
      },
    ],
  };

  const mockVariant = {
    id: 'var-1',
    productId: 'prod-1',
    name: '500ml',
    sku: 'COCONUT-500ML',
    price: 35000, // 350 INR in paise
    currency: 'INR',
    status: ProductVariantStatus.ACTIVE,
  };

  const mockCartItem = {
    id: 'item-1',
    cartId: 'cart-1',
    productId: 'prod-1',
    productVariantId: 'var-1',
    quantity: 2,
    unitPrice: 35000, // matches variant.price
    currency: 'INR',
    product: mockProduct,
    productVariant: mockVariant,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockActiveCart = {
    id: 'cart-1',
    userId: 'user-uuid-1',
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
      product: {
        findMany: vi.fn().mockImplementation(async () => {
          const val = await mockPrisma.product.findUnique();
          return val ? [val] : [];
        }),
        findUnique: vi.fn().mockResolvedValue(mockProduct),
      },
      productVariant: {
        findMany: vi.fn().mockImplementation(async () => {
          const val = await mockPrisma.productVariant.findUnique();
          return val ? [val] : [];
        }),
        findUnique: vi.fn().mockResolvedValue(mockVariant),
      },
      checkoutSession: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }: any) => ({
          id: 'checkout-session-1',
          ...data,
          items: data.items.create.map((ci: any, idx: number) => ({
            id: `snap-${idx + 1}`,
            checkoutSessionId: 'checkout-session-1',
            ...ci,
            createdAt: new Date(),
          })),
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        update: vi.fn().mockImplementation(({ data, where }: any) => ({
          id: where.id,
          userId: regularUser.id,
          cartId: 'cart-1',
          subtotal: 70000,
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
      },
      $transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockPrisma)),
    };

    mockFeatures = {
      isFeatureEnabled: vi.fn().mockResolvedValue(true),
    };

    mockAudit = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    checkoutService = new CheckoutService(
      mockPrisma,
      mockFeatures,
      mockAudit,
    );
  });

  // 1 & 2. Authenticated user can checkout own cart
  it('1 & 2: allows authenticated user to checkout own active cart and produces authoritative snapshot', async () => {
    const session = await checkoutService.initializeCheckout(regularUser);

    expect(session).toBeDefined();
    expect(session.id).toBe('checkout-session-1');
    expect(session.userId).toBe(regularUser.id);
    expect(session.cartId).toBe('cart-1');
    expect(session.subtotal).toBe(70000); // 2 * 35000 paise
    expect(session.totalItems).toBe(2);
    expect(session.isValid).toBe(true);
    expect(session.issues).toHaveLength(0);
    expect(session.items).toHaveLength(1);
    expect(session.items[0]!.unitPrice).toBe(35000);
    expect(session.items[0]!.lineTotal).toBe(70000);
  });

  // 3. User A cannot checkout User B cart
  it('3: User A cannot checkout User B cart (cart lookup scoped strictly to user.id)', async () => {
    // When otherUser calls initializeCheckout, prisma looks for otherUser's cart
    mockPrisma.cart.findFirst.mockResolvedValue(null);

    await expect(checkoutService.initializeCheckout(otherUser)).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.cart.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: otherUser.id }),
      }),
    );
  });

  // 4. ADMIN cannot checkout arbitrary user cart
  it('4: ADMIN cannot checkout arbitrary user cart; checkout is strictly bound to caller identity', async () => {
    mockPrisma.cart.findFirst.mockResolvedValue(null);

    await expect(checkoutService.initializeCheckout(adminUser)).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.cart.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: adminUser.id }),
      }),
    );
  });

  // 5. Empty cart rejected
  it('5: rejects checkout when active cart is empty', async () => {
    mockPrisma.cart.findFirst.mockResolvedValue({
      ...mockActiveCart,
      items: [],
    });

    await expect(checkoutService.initializeCheckout(regularUser)).rejects.toThrow(
      BadRequestException,
    );
  });

  // 6. Inactive product rejected
  it('6: flags issue and marks invalid when a cart product is INACTIVE', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      ...mockProduct,
      status: ProductStatus.INACTIVE,
    });

    const result = await checkoutService.initializeCheckout(regularUser);

    expect(result.isValid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.PRODUCT_UNAVAILABLE);
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 7. Inactive variant rejected
  it('7: flags issue and marks invalid when a product variant is DISCONTINUED / INACTIVE', async () => {
    mockPrisma.productVariant.findUnique.mockResolvedValue({
      ...mockVariant,
      status: ProductVariantStatus.DISCONTINUED,
    });

    const result = await checkoutService.initializeCheckout(regularUser);

    expect(result.isValid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.VARIANT_UNAVAILABLE);
  });

  // 8. Deleted variant handled
  it('8: flags issue when variant is not found in database', async () => {
    mockPrisma.productVariant.findUnique.mockResolvedValue(null);

    const result = await checkoutService.initializeCheckout(regularUser);

    expect(result.isValid).toBe(false);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.VARIANT_UNAVAILABLE);
  });

  // 9. Variant/product mismatch rejected
  it('9: flags issue when variant does not belong to product', async () => {
    mockPrisma.productVariant.findUnique.mockResolvedValue({
      ...mockVariant,
      productId: 'different-product-id',
    });

    const result = await checkoutService.initializeCheckout(regularUser);

    expect(result.isValid).toBe(false);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.VARIANT_MISMATCH);
  });

  // 10. Price change detected
  it('10: detects price change and alerts user without silently charging old price', async () => {
    // Current catalog price is 42000 paise (420 INR), but cart had 35000 paise
    mockPrisma.productVariant.findUnique.mockResolvedValue({
      ...mockVariant,
      price: 42000,
    });

    const result = await checkoutService.initializeCheckout(regularUser);

    expect(result.isValid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.PRICE_CHANGED);
    expect(result.issues[0]!.previousPrice).toBe(35000);
    expect(result.issues[0]!.currentPrice).toBe(42000);
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 11 & 12. Frontend price and subtotal ignored
  it('11 & 12: backend recalculates line total and subtotal from authoritative DB variant prices', async () => {
    // Stale cart has corrupt or manipulated values
    mockPrisma.cart.findFirst.mockResolvedValue({
      ...mockActiveCart,
      items: [
        {
          ...mockCartItem,
          unitPrice: 100, // Manipulated low price in cart
          quantity: 3,
        },
      ],
    });

    // Authoritative catalog has real price: 35000
    mockPrisma.productVariant.findUnique.mockResolvedValue(mockVariant);

    const result = await checkoutService.initializeCheckout(regularUser);

    // Because cart price (100) != catalog price (35000), it flags PRICE_CHANGED
    expect(result.isValid).toBe(false);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.PRICE_CHANGED);
    // Calculated subtotal on validated items is authoritative (3 * 35000 = 105000), not 300
    expect(result.subtotal).toBe(105000);
  });

  // 13. Quantity validation
  it('13: rejects invalid quantity (< 1 or > max limit)', async () => {
    mockPrisma.cart.findFirst.mockResolvedValue({
      ...mockActiveCart,
      items: [
        {
          ...mockCartItem,
          quantity: 999, // Exceeds DEFAULT_MAX_CART_ITEM_QUANTITY (20)
        },
      ],
    });

    const result = await checkoutService.initializeCheckout(regularUser);

    expect(result.isValid).toBe(false);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.INVALID_QUANTITY);
  });

  // 14. Currency validation
  it('14: flags issue when variant currency does not match cart currency', async () => {
    mockPrisma.productVariant.findUnique.mockResolvedValue({
      ...mockVariant,
      currency: 'USD',
    });

    const result = await checkoutService.initializeCheckout(regularUser);

    expect(result.isValid).toBe(false);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.CURRENCY_MISMATCH);
  });

  // 15 & 16. Checkout snapshot created correctly and preserves authoritative price
  it('15 & 16: creates immutable item snapshots preserving authoritative name, SKU, price, and line totals', async () => {
    const session = await checkoutService.initializeCheckout(regularUser);

    expect(mockPrisma.checkoutSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: regularUser.id,
        cartId: 'cart-1',
        currency: 'INR',
        subtotal: 70000,
        status: CheckoutStatus.ACTIVE,
        items: {
          create: [
            expect.objectContaining({
              productId: 'prod-1',
              productVariantId: 'var-1',
              productName: 'Organic Virgin Coconut Oil',
              productSku: 'COCONUT-500ML',
              quantity: 2,
              unitPrice: 35000,
              lineTotal: 70000,
            }),
          ],
        },
      }),
      include: { items: true },
    });
    expect(session.isValid).toBe(true);
  });

  // 17. Checkout expiration
  it('17: marks active session as EXPIRED when accessed past expiresAt', async () => {
    const expiredDate = new Date(Date.now() - 60000); // 1 minute in the past
    mockPrisma.checkoutSession.findUnique.mockResolvedValue({
      id: 'session-past',
      userId: regularUser.id,
      cartId: 'cart-1',
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 70000,
      expiresAt: expiredDate,
      createdAt: new Date(Date.now() - 3600000),
      updatedAt: new Date(),
      items: [],
    });

    const session = await checkoutService.getCheckoutSession(
      'session-past',
      regularUser,
    );

    expect(session.status).toBe(CheckoutStatus.EXPIRED);
    expect(session.isValid).toBe(false);
    expect(session.issues[0]!.code).toBe(CheckoutIssueCode.SESSION_EXPIRED);
    expect(mockPrisma.checkoutSession.update).toHaveBeenCalledWith({
      where: { id: 'session-past' },
      data: { status: CheckoutStatus.EXPIRED },
    });
  });

  // 18. Expired checkout cannot be reused
  it('18: revalidating an expired checkout returns SESSION_EXPIRED issue', async () => {
    mockPrisma.checkoutSession.findUnique.mockResolvedValue({
      id: 'session-past',
      userId: regularUser.id,
      cartId: 'cart-1',
      status: CheckoutStatus.EXPIRED,
      currency: 'INR',
      subtotal: 70000,
      expiresAt: new Date(Date.now() - 10000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
    });

    const result = await checkoutService.revalidateCheckout(
      'session-past',
      regularUser,
    );

    expect(result.isValid).toBe(false);
    expect(result.issues[0]!.code).toBe(CheckoutIssueCode.SESSION_EXPIRED);
  });

  // 19. Checkout idempotency
  it('19: idempotently returns existing active session if items, quantities, and prices match', async () => {
    const existingSession = {
      id: 'existing-session-1',
      userId: regularUser.id,
      cartId: 'cart-1',
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 70000,
      expiresAt: new Date(Date.now() + 1200000), // 20 min in future
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'existing-item-1',
          checkoutSessionId: 'existing-session-1',
          productId: 'prod-1',
          productVariantId: 'var-1',
          productName: 'Organic Virgin Coconut Oil',
          productSku: 'COCONUT-500ML',
          quantity: 2,
          unitPrice: 35000,
          lineTotal: 70000,
          currency: 'INR',
          primaryImageUrl: null,
          createdAt: new Date(),
        },
      ],
    };

    mockPrisma.checkoutSession.findFirst.mockResolvedValue(existingSession);

    const session = await checkoutService.initializeCheckout(regularUser);

    expect(session.id).toBe('existing-session-1');
    expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
  });

  // 20. Cart changed after checkout initialization is detected
  it('20: detects cart modification during revalidation and flags CART_CHANGED', async () => {
    const existingSession = {
      id: 'session-1',
      userId: regularUser.id,
      cartId: 'cart-1',
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 70000,
      expiresAt: new Date(Date.now() + 1000000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'item-snap-1',
          checkoutSessionId: 'session-1',
          productId: 'prod-1',
          productVariantId: 'var-1',
          productName: 'Organic Virgin Coconut Oil',
          productSku: 'COCONUT-500ML',
          quantity: 2, // snapshot was 2
          unitPrice: 35000,
          lineTotal: 70000,
          currency: 'INR',
          createdAt: new Date(),
        },
      ],
    };

    mockPrisma.checkoutSession.findUnique.mockResolvedValue(existingSession);

    // Meanwhile, user changed quantity in active cart to 5
    mockPrisma.cart.findFirst.mockResolvedValue({
      ...mockActiveCart,
      items: [
        {
          ...mockCartItem,
          quantity: 5,
        },
      ],
    });

    const result = await checkoutService.revalidateCheckout(
      'session-1',
      regularUser,
    );

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: CheckoutIssueCode.CART_CHANGED }),
      ]),
    );
  });

  // 21. Feature disabled blocks checkout
  it('21: blocks checkout initialization when CHECKOUT feature is disabled', async () => {
    mockFeatures.isFeatureEnabled.mockResolvedValue(false);

    await expect(checkoutService.initializeCheckout(regularUser)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // 22. CART dependency enforced
  it('22: passes FeatureKey.CHECKOUT to feature service to enforce CART dependency chain', async () => {
    await checkoutService.initializeCheckout(regularUser);

    expect(mockFeatures.isFeatureEnabled).toHaveBeenCalledWith(
      FeatureKey.CHECKOUT,
      regularUser,
    );
  });

  // 23. IDOR protection
  it('23: prevents User A from accessing User B checkout session (IDOR protection)', async () => {
    mockPrisma.checkoutSession.findUnique.mockResolvedValue({
      id: 'session-owned-by-user-2',
      userId: 'user-uuid-2', // owned by other user
      cartId: 'cart-2',
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 50000,
      expiresAt: new Date(Date.now() + 1000000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
    });

    await expect(
      checkoutService.getCheckoutSession('session-owned-by-user-2', regularUser),
    ).rejects.toThrow(ForbiddenException);

    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CHECKOUT_SECURITY_VIOLATION,
        entityType: AuditEntityType.CHECKOUT,
      }),
    );
  });

  // 24. Audit and security behavior
  it('24: logs sanitized audit events on checkout initialization and cancellation', async () => {
    await checkoutService.initializeCheckout(regularUser);

    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CHECKOUT_INITIALIZED,
        entityType: AuditEntityType.CHECKOUT,
        actorId: regularUser.id,
      }),
    );

    mockPrisma.checkoutSession.findUnique.mockResolvedValue({
      id: 'session-cancel-1',
      userId: regularUser.id,
      cartId: 'cart-1',
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 70000,
      expiresAt: new Date(Date.now() + 1000000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
    });

    await checkoutService.cancelCheckout('session-cancel-1', regularUser);

    expect(mockAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CHECKOUT_CANCELLED,
        entityType: AuditEntityType.CHECKOUT,
        actorId: regularUser.id,
      }),
    );
  });

  // ===========================================================================
  // PHASE 06 REMEDIATION: PRE-PAYMENT HARDENING & IDEMPOTENCY REGRESSION TESTS
  // ===========================================================================
  describe('Phase 06 Remediation — Pre-Payment Hardening & Idempotency', () => {
    it('R1: client idempotency key is persisted in created session', async () => {
      const session = await checkoutService.initializeCheckout(
        regularUser,
        'client-key-alpha-123',
      );

      expect(mockPrisma.checkoutSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            idempotencyKey: 'client-key-alpha-123',
          }),
        }),
      );
      expect(session.idempotencyKey).toBe('client-key-alpha-123');
    });

    it('R2: same key returns same session without creating a new session', async () => {
      const existingSessionWithKey = {
        id: 'session-idempotent-1',
        userId: regularUser.id,
        cartId: 'cart-1',
        status: CheckoutStatus.ACTIVE,
        currency: 'INR',
        subtotal: 70000,
        idempotencyKey: 'client-key-repeat-1',
        expiresAt: new Date(Date.now() + 1800000),
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-snap-1',
            checkoutSessionId: 'session-idempotent-1',
            productId: 'prod-1',
            productVariantId: 'var-1',
            productName: 'Organic Virgin Coconut Oil',
            productSku: 'COCONUT-500ML',
            quantity: 2,
            unitPrice: 35000,
            lineTotal: 70000,
            currency: 'INR',
            createdAt: new Date(),
          },
        ],
      };

      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(
        existingSessionWithKey,
      );

      const session = await checkoutService.initializeCheckout(
        regularUser,
        'client-key-repeat-1',
      );

      expect(session.id).toBe('session-idempotent-1');
      expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.checkoutSession.findUnique).toHaveBeenCalledWith({
        where: {
          userId_idempotencyKey: {
            userId: regularUser.id,
            idempotencyKey: 'client-key-repeat-1',
          },
        },
        include: { items: true },
      });
    });

    it('R3: different key does not return key-1 session and creates new session', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(null);

      const session = await checkoutService.initializeCheckout(
        regularUser,
        'client-key-different-2',
      );

      expect(mockPrisma.checkoutSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            idempotencyKey: 'client-key-different-2',
          }),
        }),
      );
      expect(session.idempotencyKey).toBe('client-key-different-2');
    });

    it('R4: different user with same key is strictly isolated', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(null);

      await checkoutService.initializeCheckout(otherUser, 'shared-client-key');

      expect(mockPrisma.checkoutSession.findUnique).toHaveBeenCalledWith({
        where: {
          userId_idempotencyKey: {
            userId: otherUser.id,
            idempotencyKey: 'shared-client-key',
          },
        },
        include: { items: true },
      });
    });

    it('R5: no-key repeated request reuses active session without creating duplicate', async () => {
      const activeSession = {
        id: 'active-session-no-key',
        userId: regularUser.id,
        cartId: 'cart-1',
        status: CheckoutStatus.ACTIVE,
        currency: 'INR',
        subtotal: 70000,
        idempotencyKey: null,
        expiresAt: new Date(Date.now() + 1800000),
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-snap-1',
            checkoutSessionId: 'active-session-no-key',
            productId: 'prod-1',
            productVariantId: 'var-1',
            productName: 'Organic Virgin Coconut Oil',
            productSku: 'COCONUT-500ML',
            quantity: 2,
            unitPrice: 35000,
            lineTotal: 70000,
            currency: 'INR',
            createdAt: new Date(),
          },
        ],
      };

      mockPrisma.checkoutSession.findFirst.mockResolvedValueOnce(activeSession);

      const session = await checkoutService.initializeCheckout(regularUser);

      expect(session.id).toBe('active-session-no-key');
      expect(mockPrisma.checkoutSession.create).not.toHaveBeenCalled();
    });

    it('R6: handles concurrent initialize race condition (P2002 conflict) by returning concurrent active session', async () => {
      const concurrentSession = {
        id: 'concurrent-session-winner',
        userId: regularUser.id,
        cartId: 'cart-1',
        status: CheckoutStatus.ACTIVE,
        currency: 'INR',
        subtotal: 70000,
        idempotencyKey: 'race-key-1',
        expiresAt: new Date(Date.now() + 1800000),
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      };

      // Initial check found null (simulating concurrent timing)
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(null);
      mockPrisma.checkoutSession.findFirst.mockResolvedValueOnce(null);

      // Create throws PostgreSQL unique constraint violation (P2002)
      mockPrisma.checkoutSession.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      // On conflict catch, findUnique or findFirst retrieves the winning concurrent session
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(
        concurrentSession,
      );

      const session = await checkoutService.initializeCheckout(
        regularUser,
        'race-key-1',
      );

      expect(session.id).toBe('concurrent-session-winner');
    });

    it('R7: expired session does not block new checkout and is updated to EXPIRED', async () => {
      const expiredSession = {
        id: 'session-expired-prev',
        userId: regularUser.id,
        cartId: 'cart-1',
        status: CheckoutStatus.ACTIVE,
        currency: 'INR',
        subtotal: 70000,
        idempotencyKey: null,
        expiresAt: new Date(Date.now() - 5000), // in the past
        createdAt: new Date(Date.now() - 3600000),
        updatedAt: new Date(),
        items: [],
      };

      mockPrisma.checkoutSession.findFirst.mockResolvedValueOnce(expiredSession);

      const session = await checkoutService.initializeCheckout(regularUser);

      expect(mockPrisma.checkoutSession.update).toHaveBeenCalledWith({
        where: { id: 'session-expired-prev' },
        data: { status: CheckoutStatus.EXPIRED },
      });
      expect(mockPrisma.checkoutSession.create).toHaveBeenCalled();
      expect(session.status).toBe(CheckoutStatus.ACTIVE);
    });

    it('R8: cancelled session does not block new checkout', async () => {
      // No active session found (previous was CANCELLED)
      mockPrisma.checkoutSession.findFirst.mockResolvedValueOnce(null);

      const session = await checkoutService.initializeCheckout(regularUser);

      expect(mockPrisma.checkoutSession.create).toHaveBeenCalled();
      expect(session.status).toBe(CheckoutStatus.ACTIVE);
    });

    it('R9: completed session does not block new checkout', async () => {
      // Completed session is filtered out by status: ACTIVE
      mockPrisma.checkoutSession.findFirst.mockResolvedValueOnce(null);

      const session = await checkoutService.initializeCheckout(regularUser);

      expect(mockPrisma.checkoutSession.create).toHaveBeenCalled();
      expect(session.status).toBe(CheckoutStatus.ACTIVE);
    });

    it('R10: stale price blocks future payment boundary (assertCheckoutReadyForPayment)', async () => {
      const activeSession = {
        id: 'session-pay-ready',
        userId: regularUser.id,
        cartId: 'cart-1',
        status: CheckoutStatus.ACTIVE,
        currency: 'INR',
        subtotal: 70000,
        expiresAt: new Date(Date.now() + 1800000),
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-snap-1',
            checkoutSessionId: 'session-pay-ready',
            productId: 'prod-1',
            productVariantId: 'var-1',
            productName: 'Organic Virgin Coconut Oil',
            productSku: 'COCONUT-500ML',
            quantity: 2,
            unitPrice: 35000,
            lineTotal: 70000,
            currency: 'INR',
            createdAt: new Date(),
          },
        ],
      };

      mockPrisma.checkoutSession.findUnique.mockResolvedValue(activeSession);

      // Case A: Catalog price changed from 35000 to 45000
      mockPrisma.productVariant.findUnique.mockResolvedValueOnce({
        ...mockVariant,
        price: 45000,
      });

      await expect(
        checkoutService.assertCheckoutReadyForPayment(
          'session-pay-ready',
          regularUser,
        ),
      ).rejects.toThrow(BadRequestException);

      // Case B: Catalog price matches snapshot price -> payment boundary allows progression and returns authoritative amount
      mockPrisma.productVariant.findUnique.mockResolvedValue(mockVariant);

      const ready = await checkoutService.assertCheckoutReadyForPayment(
        'session-pay-ready',
        regularUser,
      );

      expect(ready.payableAmount).toBe(70000);
      expect(ready.currency).toBe('INR');
      expect(ready.session.id).toBe('session-pay-ready');
    });

    it('R11: historical checkout survives cart deletion with cartId: null', async () => {
      const historicalSession = {
        id: 'session-historical-1',
        userId: regularUser.id,
        cartId: null, // Cart was deleted/cleaned up
        status: CheckoutStatus.COMPLETED,
        currency: 'INR',
        subtotal: 70000,
        idempotencyKey: null,
        expiresAt: new Date(Date.now() + 1800000),
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      };

      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(
        historicalSession,
      );

      const session = await checkoutService.getCheckoutSession(
        'session-historical-1',
        regularUser,
      );

      expect(session.cartId).toBeNull();
      expect(session.id).toBe('session-historical-1');
    });

    it('R12 & R13: performs batched findMany queries for products and variants, eliminating N+1 queries', async () => {
      // Cart with 3 items referencing 2 products and 3 variants
      mockPrisma.cart.findFirst.mockResolvedValueOnce({
        ...mockActiveCart,
        items: [
          mockCartItem,
          {
            ...mockCartItem,
            id: 'item-2',
            productVariantId: 'var-2',
          },
          {
            ...mockCartItem,
            id: 'item-3',
            productId: 'prod-2',
            productVariantId: 'var-3',
          },
        ],
      });

      mockPrisma.product.findMany.mockResolvedValueOnce([
        mockProduct,
        { ...mockProduct, id: 'prod-2', name: 'Almond Oil' },
      ]);

      mockPrisma.productVariant.findMany.mockResolvedValueOnce([
        mockVariant,
        { ...mockVariant, id: 'var-2', name: '1L' },
        { ...mockVariant, id: 'var-3', productId: 'prod-2', name: '250ml' },
      ]);

      await checkoutService.initializeCheckout(regularUser);

      // Verify exactly ONE product.findMany call with in: ['prod-1', 'prod-2']
      expect(mockPrisma.product.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['prod-1', 'prod-2'] } },
        }),
      );

      // Verify exactly ONE productVariant.findMany call with in: ['var-1', 'var-2', 'var-3']
      expect(mockPrisma.productVariant.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.productVariant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['var-1', 'var-2', 'var-3'] } },
        }),
      );

      // Verify findUnique was NOT called sequentially in a loop
      expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.productVariant.findUnique).not.toHaveBeenCalled();
    });

    it('R14: missing product from batched query flags PRODUCT_UNAVAILABLE', async () => {
      mockPrisma.product.findMany.mockResolvedValueOnce([]); // Product not in DB

      const result = await checkoutService.initializeCheckout(regularUser);

      expect(result.isValid).toBe(false);
      expect(result.issues[0]!.code).toBe(
        CheckoutIssueCode.PRODUCT_UNAVAILABLE,
      );
    });

    it('R15: missing variant from batched query flags VARIANT_UNAVAILABLE', async () => {
      mockPrisma.productVariant.findMany.mockResolvedValueOnce([]); // Variant not in DB

      const result = await checkoutService.initializeCheckout(regularUser);

      expect(result.isValid).toBe(false);
      expect(result.issues[0]!.code).toBe(
        CheckoutIssueCode.VARIANT_UNAVAILABLE,
      );
    });

    it('R16: inactive product in batched query flags PRODUCT_UNAVAILABLE', async () => {
      mockPrisma.product.findMany.mockResolvedValueOnce([
        { ...mockProduct, status: ProductStatus.INACTIVE },
      ]);

      const result = await checkoutService.initializeCheckout(regularUser);

      expect(result.isValid).toBe(false);
      expect(result.issues[0]!.code).toBe(
        CheckoutIssueCode.PRODUCT_UNAVAILABLE,
      );
    });

    it('R17: inactive variant in batched query flags VARIANT_UNAVAILABLE', async () => {
      mockPrisma.productVariant.findMany.mockResolvedValueOnce([
        { ...mockVariant, status: ProductVariantStatus.DISCONTINUED },
      ]);

      const result = await checkoutService.initializeCheckout(regularUser);

      expect(result.isValid).toBe(false);
      expect(result.issues[0]!.code).toBe(
        CheckoutIssueCode.VARIANT_UNAVAILABLE,
      );
    });
  });

  describe('Shipping Address & Payment Boundary Freeze', () => {
    const validShippingAddress = {
      name: 'Hari Raman',
      phone: '+919876543210',
      line1: '123 Natural Way',
      line2: 'Suite 4',
      city: 'Chennai',
      state: 'Tamil Nadu',
      postalCode: '600001',
      country: 'IN',
    };

    const mockActiveSessionWithItems = {
      id: 'session-shipping-1',
      userId: regularUser.id,
      cartId: 'cart-1',
      status: CheckoutStatus.ACTIVE,
      currency: 'INR',
      subtotal: 70000,
      expiresAt: new Date(Date.now() + 1800000),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'snap-1',
          checkoutSessionId: 'session-shipping-1',
          productId: 'prod-1',
          productVariantId: 'var-1',
          productName: 'Organic Virgin Coconut Oil',
          variantName: '500ml',
          productSku: 'COCO-500ML',
          quantity: 2,
          unitPrice: 35000,
          lineTotal: 70000,
          currency: 'INR',
          primaryImageUrl: null,
          createdAt: new Date(),
        },
      ],
      shippingName: null,
      shippingPhone: null,
      shippingLine1: null,
      shippingLine2: null,
      shippingCity: null,
      shippingState: null,
      shippingPostalCode: null,
      shippingCountry: null,
    };

    it('mutates shipping address on active session when no active payment exists', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockActiveSessionWithItems);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValue(null);

      const result = await checkoutService.updateShippingAddress(
        'session-shipping-1',
        regularUser,
        validShippingAddress,
      );

      expect(mockPrisma.checkoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-shipping-1' },
          data: expect.objectContaining({
            shippingName: 'Hari Raman',
            shippingCity: 'Chennai',
            shippingCountry: 'IN',
          }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('blocks shipping address mutation with ConflictException when active payment in CREATED status exists', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockActiveSessionWithItems);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-created-1',
        status: PaymentStatus.CREATED,
      });

      const err = await checkoutService
        .updateShippingAddress('session-shipping-1', regularUser, validShippingAddress)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: 'ACTIVE_PAYMENT_EXISTS',
        paymentAttemptId: 'attempt-created-1',
      });
    });

    it('blocks shipping address mutation with ConflictException when active payment in PENDING status exists', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockActiveSessionWithItems);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-pending-1',
        status: PaymentStatus.PENDING,
      });

      const err = await checkoutService
        .updateShippingAddress('session-shipping-1', regularUser, validShippingAddress)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: 'ACTIVE_PAYMENT_EXISTS',
        paymentAttemptId: 'attempt-pending-1',
      });
    });

    it('blocks shipping address mutation with ConflictException when payment has already been CAPTURED', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockActiveSessionWithItems);
      mockPrisma.paymentAttempt.findFirst
        .mockResolvedValueOnce(null) // no CREATED/PENDING
        .mockResolvedValueOnce({
          id: 'attempt-captured-1',
          status: PaymentStatus.CAPTURED,
        });

      const err = await checkoutService
        .updateShippingAddress('session-shipping-1', regularUser, validShippingAddress)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: 'PAYMENT_ALREADY_CAPTURED',
        paymentAttemptId: 'attempt-captured-1',
      });
    });

    it('blocks shipping address mutation for unauthorized user (IDOR protection)', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockActiveSessionWithItems);

      await expect(
        checkoutService.updateShippingAddress(
          'session-shipping-1',
          otherUser,
          validShippingAddress,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks session cancellation with ConflictException when active payment exists', async () => {
      mockPrisma.checkoutSession.findUnique.mockResolvedValueOnce(mockActiveSessionWithItems);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-active-1',
        status: PaymentStatus.PENDING,
      });

      const err = await checkoutService
        .cancelCheckout('session-shipping-1', regularUser)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: 'ACTIVE_PAYMENT_EXISTS',
      });
    });
  });
});
