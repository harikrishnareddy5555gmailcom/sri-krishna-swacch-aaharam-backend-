import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { FeaturesService } from '../features/features.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  FeatureKey,
  CheckoutIssueCode,
  DEFAULT_MAX_CART_ITEM_QUANTITY,
  DEFAULT_CHECKOUT_SESSION_EXPIRY_MINUTES,
  AuditAction,
  AuditEntityType,
  type CheckoutStatus as TypesCheckoutStatus,
  type CheckoutSessionDto,
  type CheckoutItemSnapshotDto,
  type CheckoutValidationIssue,
  type RevalidateCheckoutResultDto,
} from '@vishkaraa/types';
import {
  CartStatus,
  ProductStatus,
  ProductVariantStatus,
  CheckoutStatus,
  PaymentStatus,
  ReservationStatus,
  Prisma,
} from '@prisma/client';
import type { MinimalUser } from '../permissions/permissions.service.js';
import type { ShippingAddressDto, BuyNowItemDto } from './dto/initialize-checkout.dto.js';
import { InventoryService } from '../inventory/inventory.service.js';

type CheckoutSessionWithItems = Prisma.CheckoutSessionGetPayload<{
  include: {
    items: true;
  };
}>;

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly featuresService: FeaturesService,
    private readonly auditService: AuditService,
    @Optional() @Inject(InventoryService) private readonly inventoryService?: InventoryService,
  ) {}

  /**
   * Asserts that the CHECKOUT feature and its dependencies (e.g. CART) are active and accessible.
   */
  private async assertFeatureEnabled(user?: MinimalUser): Promise<void> {
    const isEnabled = await this.featuresService.isFeatureEnabled(
      FeatureKey.CHECKOUT,
      user,
    );
    if (!isEnabled) {
      throw new ServiceUnavailableException(
        'Checkout feature is currently unavailable',
      );
    }
  }

  /**
   * Initializes or idempotently retrieves an authoritative checkout session for the authenticated user's active cart.
   *
   * Idempotency Protections:
   * 1. Client Idempotency: Persists client-supplied key and enforces [userId, idempotencyKey] uniqueness.
   * 2. Active Checkout Concurrency: PostgreSQL partial unique index prevents concurrent duplicate ACTIVE sessions.
   *
   * Query Optimization:
   * Batches product and variant queries to eliminate N+1 database roundtrips.
   */
  async initializeCheckout(
    user: MinimalUser,
    idempotencyKey?: string,
    shippingAddress?: ShippingAddressDto,
    buyNowItem?: BuyNowItemDto,
  ): Promise<CheckoutSessionDto> {
    await this.assertFeatureEnabled(user);

    const now = new Date();

    // 0. Client Idempotency Check: if idempotencyKey supplied, return existing session if found
    if (idempotencyKey) {
      const existingByKey = await this.prisma.checkoutSession.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: user.id,
            idempotencyKey,
          },
        },
        include: { items: true },
      });

      if (existingByKey) {
        const isExpired = existingByKey.expiresAt <= now;
        if (isExpired && existingByKey.status === CheckoutStatus.ACTIVE) {
          await this.prisma.checkoutSession.update({
            where: { id: existingByKey.id },
            data: { status: CheckoutStatus.EXPIRED },
          });
          existingByKey.status = CheckoutStatus.EXPIRED;
        }
        const isValid =
          existingByKey.status === CheckoutStatus.ACTIVE && !isExpired;
        return this.mapToDto(existingByKey, isValid, []);
      }
    }

    // Branch to dedicated Buy Now session creation if buyNowItem is supplied
    if (buyNowItem) {
      return this.initializeBuyNowCheckout(
        user,
        buyNowItem,
        idempotencyKey,
        shippingAddress,
      );
    }

    // 1. Load authenticated user's active cart
    const cart = await this.prisma.cart.findFirst({
      where: {
        userId: user.id,
        status: CartStatus.ACTIVE,
      },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException({
        code: CheckoutIssueCode.CART_EMPTY,
        message:
          'Your cart is empty. Please add items to your cart before proceeding to checkout.',
      });
    }

    // 2. Batched Catalog Query: Fetch all products and variants in 2 database queries (eliminating N+1)
    const productIds = Array.from(new Set(cart.items.map((i) => i.productId)));
    const variantIds = Array.from(
      new Set(cart.items.map((i) => i.productVariantId)),
    );

    const [liveProducts, liveVariants] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        include: {
          media: {
            where: { isPrimary: true },
            take: 1,
          },
        },
      }),
      this.prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
      }),
    ]);

    const productMap = new Map(liveProducts.map((p) => [p.id, p]));
    const variantMap = new Map(liveVariants.map((v) => [v.id, v]));

    // Pre-check: Look for an existing, non-expired ACTIVE session for this user and cart
    const existingActiveSession = await this.prisma.checkoutSession.findFirst({
      where: {
        userId: user.id,
        cartId: cart.id,
        status: CheckoutStatus.ACTIVE,
      },
      include: {
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // 3. Validate cart items against authoritative catalog and inventory state
    const issues: CheckoutValidationIssue[] = [];
    let authoritativeSubtotal = 0;
    let totalItems = 0;

    const validatedItems: {
      cartItemId: string;
      productId: string;
      productVariantId: string;
      productName: string;
      variantName: string;
      productSku: string;
      quantity: number;
      unitPrice: number;
      lineTotal: number;
      currency: string;
      primaryImageUrl?: string | null;
    }[] = [];

    for (const item of cart.items) {
      totalItems += item.quantity;

      // Quantity validation
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0 ||
        item.quantity > DEFAULT_MAX_CART_ITEM_QUANTITY
      ) {
        issues.push({
          code: CheckoutIssueCode.INVALID_QUANTITY,
          message: `Quantity for product must be between 1 and ${DEFAULT_MAX_CART_ITEM_QUANTITY}.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          cartItemId: item.id,
          requestedQuantity: item.quantity,
          maxQuantity: DEFAULT_MAX_CART_ITEM_QUANTITY,
        });
        continue;
      }

      // Live product lookup from batched map
      const liveProduct = productMap.get(item.productId);

      if (!liveProduct || liveProduct.status !== ProductStatus.ACTIVE) {
        issues.push({
          code: CheckoutIssueCode.PRODUCT_UNAVAILABLE,
          message: `Product "${liveProduct?.name ?? item.productId}" is no longer available.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          cartItemId: item.id,
          productName: liveProduct?.name ?? 'Unknown Product',
        });
        continue;
      }

      // Live variant lookup from batched map
      const liveVariant = variantMap.get(item.productVariantId);

      if (!liveVariant || liveVariant.status !== ProductVariantStatus.ACTIVE) {
        issues.push({
          code: CheckoutIssueCode.VARIANT_UNAVAILABLE,
          message: `Selected variant for "${liveProduct.name}" is no longer available.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          cartItemId: item.id,
          productName: liveProduct.name,
        });
        continue;
      }

      // Verify variant belongs to product
      if (liveVariant.productId !== liveProduct.id) {
        issues.push({
          code: CheckoutIssueCode.VARIANT_MISMATCH,
          message: 'Variant does not match the product in your cart.',
          productId: item.productId,
          productVariantId: item.productVariantId,
          cartItemId: item.id,
        });
        continue;
      }

      // Verify currency
      if (liveVariant.currency !== cart.currency) {
        issues.push({
          code: CheckoutIssueCode.CURRENCY_MISMATCH,
          message: `Currency mismatch between variant (${liveVariant.currency}) and cart (${cart.currency}).`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          cartItemId: item.id,
        });
        continue;
      }

      // Authoritative Price Verification
      if (item.unitPrice !== liveVariant.price) {
        issues.push({
          code: CheckoutIssueCode.PRICE_CHANGED,
          message: `Price for "${liveProduct.name} (${liveVariant.name})" has changed from ₹${(item.unitPrice / 100).toFixed(2)} to ₹${(liveVariant.price / 100).toFixed(2)}.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          cartItemId: item.id,
          productName: liveProduct.name,
          sku: liveVariant.sku,
          previousPrice: item.unitPrice,
          currentPrice: liveVariant.price,
        });
      }

      // Stock Availability Verification (when inventory service is active)
      if (this.inventoryService) {
        const stockBalance = await this.inventoryService.getBalance(liveVariant.id);
        let effectiveAvailable = stockBalance.available;
        if (existingActiveSession && existingActiveSession.expiresAt > now) {
          const existingItem = existingActiveSession.items.find(
            (si) => si.productVariantId === liveVariant.id,
          );
          if (existingItem) {
            effectiveAvailable += existingItem.quantity;
          }
        }

        if (effectiveAvailable < item.quantity) {
          issues.push({
            code: CheckoutIssueCode.INSUFFICIENT_STOCK,
            message: `Insufficient stock for "${liveProduct.name} (${liveVariant.name})". Available: ${effectiveAvailable}, Requested: ${item.quantity}.`,
            productId: item.productId,
            productVariantId: item.productVariantId,
            cartItemId: item.id,
            productName: liveProduct.name,
            sku: liveVariant.sku,
            requestedQuantity: item.quantity,
            availableQuantity: effectiveAvailable,
          });
        }
      }

      // Calculate line total with authoritative current price
      const lineTotal = liveVariant.price * item.quantity;
      authoritativeSubtotal += lineTotal;

      validatedItems.push({
        cartItemId: item.id,
        productId: liveProduct.id,
        productVariantId: liveVariant.id,
        productName: liveProduct.name,
        variantName: liveVariant.name,
        productSku: liveVariant.sku,
        quantity: item.quantity,
        unitPrice: liveVariant.price,
        lineTotal,
        currency: liveVariant.currency,
        primaryImageUrl: liveProduct.media[0]?.url ?? null,
      });
    }

    // 4. If there are validation issues, return structured issue response without persisting active session
    if (issues.length > 0) {
      return {
        id: '',
        userId: user.id,
        cartId: cart.id,
        status: CheckoutStatus.CANCELLED as TypesCheckoutStatus,
        currency: cart.currency,
        subtotal: authoritativeSubtotal,
        totalItems,
        items: validatedItems.map((vi) => ({
          id: vi.cartItemId,
          checkoutSessionId: '',
          productId: vi.productId,
          productVariantId: vi.productVariantId,
          productName: vi.productName,
          variantName: vi.variantName,
          productSku: vi.productSku,
          quantity: vi.quantity,
          unitPrice: vi.unitPrice,
          lineTotal: vi.lineTotal,
          currency: vi.currency,
          primaryImageUrl: vi.primaryImageUrl,
          createdAt: now.toISOString(),
        })),
        isValid: false,
        issues,
        idempotencyKey: idempotencyKey ?? null,
        expiresAt: new Date(
          now.getTime() + DEFAULT_CHECKOUT_SESSION_EXPIRY_MINUTES * 60 * 1000,
        ).toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    }

    // 5. Existing Active Session Check: Look for an existing, non-expired ACTIVE session for this user and cart
    if (existingActiveSession) {
      if (existingActiveSession.expiresAt <= now) {
        await this.prisma.checkoutSession.update({
          where: { id: existingActiveSession.id },
          data: { status: CheckoutStatus.EXPIRED },
        });
        if (this.inventoryService) {
          await this.inventoryService.releaseReservation(
            existingActiveSession.id,
            user.id,
            'Checkout session expired',
          );
        }
      } else {
        // Check if items and prices match the current cart state
        const itemsMatch =
          existingActiveSession.items.length === validatedItems.length &&
          existingActiveSession.subtotal === authoritativeSubtotal &&
          validatedItems.every((vi) =>
            existingActiveSession.items.some(
              (si) =>
                si.productVariantId === vi.productVariantId &&
                si.quantity === vi.quantity &&
                si.unitPrice === vi.unitPrice,
            ),
          );

        if (itemsMatch) {
          // If no new key, or existing key matches, reuse existing active session
          if (
            !idempotencyKey ||
            existingActiveSession.idempotencyKey === idempotencyKey
          ) {
            if (shippingAddress) {
              const addressMatches =
                existingActiveSession.shippingName === (shippingAddress.name ?? null) &&
                existingActiveSession.shippingPhone === (shippingAddress.phone ?? null) &&
                existingActiveSession.shippingLine1 === (shippingAddress.line1 ?? null) &&
                existingActiveSession.shippingLine2 === (shippingAddress.line2 ?? null) &&
                existingActiveSession.shippingCity === (shippingAddress.city ?? null) &&
                existingActiveSession.shippingState === (shippingAddress.state ?? null) &&
                existingActiveSession.shippingPostalCode === (shippingAddress.postalCode ?? null) &&
                existingActiveSession.shippingCountry === (shippingAddress.country ?? null);

              if (!addressMatches) {
                // Customer wants to mutate shipping address on this active session.
                // Guard: cannot mutate shipping address while an active or captured payment attempt exists.
                const activePayment = await this.prisma.paymentAttempt.findFirst({
                  where: {
                    checkoutSessionId: existingActiveSession.id,
                    status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
                  },
                });
                if (activePayment) {
                  throw new ConflictException({
                    code: 'ACTIVE_PAYMENT_EXISTS',
                    message:
                      'Cannot update checkout session shipping address while an active payment attempt is in progress.',
                    paymentAttemptId: activePayment.id,
                  });
                }

                const capturedPayment = await this.prisma.paymentAttempt.findFirst({
                  where: {
                    checkoutSessionId: existingActiveSession.id,
                    status: PaymentStatus.CAPTURED,
                  },
                });
                if (capturedPayment) {
                  throw new ConflictException({
                    code: 'PAYMENT_ALREADY_CAPTURED',
                    message:
                      'Cannot update checkout session shipping address after payment has been captured.',
                    paymentAttemptId: capturedPayment.id,
                  });
                }

                const updated = await this.prisma.checkoutSession.update({
                  where: { id: existingActiveSession.id },
                  data: {
                    shippingName:       shippingAddress.name       ?? null,
                    shippingPhone:      shippingAddress.phone      ?? null,
                    shippingLine1:      shippingAddress.line1      ?? null,
                    shippingLine2:      shippingAddress.line2      ?? null,
                    shippingCity:       shippingAddress.city       ?? null,
                    shippingState:      shippingAddress.state      ?? null,
                    shippingPostalCode: shippingAddress.postalCode ?? null,
                    shippingCountry:    shippingAddress.country    ?? null,
                  },
                  include: { items: true },
                });
                return this.mapToDto(updated, true, []);
              }
            }
            return this.mapToDto(existingActiveSession, true, []);
          }
        }

        // Cart changed or new idempotency key requested: cancel stale active session so new session can be created
        // Payment boundary guard: cannot cancel an active session if a payment attempt is currently active!
        const activePayment = await this.prisma.paymentAttempt.findFirst({
          where: {
            checkoutSessionId: existingActiveSession.id,
            status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
          },
        });
        if (activePayment) {
          throw new ConflictException({
            code: 'ACTIVE_PAYMENT_EXISTS',
            message:
              'An active payment attempt is already in progress for this checkout session.',
            paymentAttemptId: activePayment.id,
          });
        }

        await this.prisma.checkoutSession.update({
          where: { id: existingActiveSession.id },
          data: { status: CheckoutStatus.CANCELLED },
        });

        if (this.inventoryService) {
          await this.inventoryService.releaseReservation(
            existingActiveSession.id,
            user.id,
            'Checkout session replaced or cancelled due to cart mutation',
          );
        }
      }
    }

    // 6. Create new authoritative checkout session and immutable item snapshots
    const expiresAt = new Date(
      now.getTime() + DEFAULT_CHECKOUT_SESSION_EXPIRY_MINUTES * 60 * 1000,
    );

    try {
      const session = await this.prisma.$transaction(async (tx) => {
        const createdSession = await tx.checkoutSession.create({
          data: {
            userId: user.id,
            cartId: cart.id,
            status: CheckoutStatus.ACTIVE,
            currency: cart.currency,
            subtotal: authoritativeSubtotal,
            idempotencyKey: idempotencyKey ?? null,
            expiresAt,
            // Shipping address — stored when provided at checkout time
            shippingName:       shippingAddress?.name       ?? null,
            shippingPhone:      shippingAddress?.phone      ?? null,
            shippingLine1:      shippingAddress?.line1      ?? null,
            shippingLine2:      shippingAddress?.line2      ?? null,
            shippingCity:       shippingAddress?.city       ?? null,
            shippingState:      shippingAddress?.state      ?? null,
            shippingPostalCode: shippingAddress?.postalCode ?? null,
            shippingCountry:    shippingAddress?.country    ?? null,
            items: {
              create: validatedItems.map((vi) => ({
                productId: vi.productId,
                productVariantId: vi.productVariantId,
                productName: vi.productName,
                variantName: vi.variantName,
                productSku: vi.productSku,
                quantity: vi.quantity,
                unitPrice: vi.unitPrice,
                lineTotal: vi.lineTotal,
                currency: vi.currency,
                primaryImageUrl: vi.primaryImageUrl,
              })),
            },
          },
          include: {
            items: true,
          },
        });

        // Atomically reserve stock in the same transaction if inventory service is present
        if (this.inventoryService) {
          await this.inventoryService.reserveStock(
            {
              checkoutSessionId: createdSession.id,
              items: validatedItems.map((vi) => ({
                variantId: vi.productVariantId,
                quantity: vi.quantity,
              })),
              expiresAt,
              actorId: user.id,
            },
            tx,
          );
        }

        return createdSession;
      });

      // Record low-noise audit log
      await this.auditService.logEvent({
        actorId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        action: AuditAction.CHECKOUT_INITIALIZED,
        entityType: AuditEntityType.CHECKOUT,
        entityId: session.id,
        metadata: {
          amount: authoritativeSubtotal,
          currency: session.currency,
          cartId: cart.id,
          itemCount: session.items.length,
          idempotencyKey: session.idempotencyKey,
          expiresAt: session.expiresAt.toISOString(),
        },
      });

      return this.mapToDto(session, true, []);
    } catch (error) {
      // Concurrency conflict handling (P2002: unique constraint or partial unique index violation)
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Check if concurrent request with same idempotencyKey created the session
        if (idempotencyKey) {
          const concurrentByKey = await this.prisma.checkoutSession.findUnique({
            where: {
              userId_idempotencyKey: {
                userId: user.id,
                idempotencyKey,
              },
            },
            include: { items: true },
          });
          if (concurrentByKey) {
            return this.mapToDto(concurrentByKey, true, []);
          }
        }

        // Check if concurrent request created an ACTIVE session for this user/cart
        const concurrentActive = await this.prisma.checkoutSession.findFirst({
          where: {
            userId: user.id,
            cartId: cart.id,
            status: CheckoutStatus.ACTIVE,
          },
          include: { items: true },
          orderBy: { createdAt: 'desc' },
        });

        if (concurrentActive) {
          return this.mapToDto(concurrentActive, true, []);
        }
      }

      throw error;
    }
  }

  /**
   * Initializes or idempotently retrieves a server-authoritative Buy Now checkout session.
   * Creates a dedicated CheckoutSession with cartId: null containing only the requested item.
   * Completely bypasses and preserves the customer's active persistent cart.
   */
  private async initializeBuyNowCheckout(
    user: MinimalUser,
    buyNowItem: BuyNowItemDto,
    idempotencyKey?: string,
    shippingAddress?: ShippingAddressDto,
  ): Promise<CheckoutSessionDto> {
    const now = new Date();

    // 0. Strict validation of buyNowItem input
    if (
      !buyNowItem ||
      typeof buyNowItem.productId !== 'string' ||
      !buyNowItem.productId.trim() ||
      typeof buyNowItem.productVariantId !== 'string' ||
      !buyNowItem.productVariantId.trim() ||
      !Number.isInteger(buyNowItem.quantity) ||
      buyNowItem.quantity < 1 ||
      buyNowItem.quantity > DEFAULT_MAX_CART_ITEM_QUANTITY
    ) {
      throw new BadRequestException({
        code: CheckoutIssueCode.INVALID_QUANTITY,
        message: `Quantity for product must be between 1 and ${DEFAULT_MAX_CART_ITEM_QUANTITY}.`,
      });
    }

    // 1. Fetch live product and variant from database
    const [product, variant] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: buyNowItem.productId },
        include: {
          media: {
            where: { isPrimary: true },
            take: 1,
          },
        },
      }),
      this.prisma.productVariant.findUnique({
        where: { id: buyNowItem.productVariantId },
      }),
    ]);

    // 2. Authoritative product & variant validation
    const issues: CheckoutValidationIssue[] = [];

    if (!product || product.status !== ProductStatus.ACTIVE) {
      issues.push({
        code: CheckoutIssueCode.PRODUCT_UNAVAILABLE,
        message: `Product "${product?.name ?? buyNowItem.productId}" is no longer available.`,
        productId: buyNowItem.productId,
        productVariantId: buyNowItem.productVariantId,
        productName: product?.name ?? 'Unknown Product',
      });
    }

    if (!variant || variant.status !== ProductVariantStatus.ACTIVE) {
      issues.push({
        code: CheckoutIssueCode.VARIANT_UNAVAILABLE,
        message: 'Selected variant is no longer available.',
        productId: buyNowItem.productId,
        productVariantId: buyNowItem.productVariantId,
        productName: product?.name ?? 'Unknown Product',
      });
    } else if (product && variant.productId !== product.id) {
      issues.push({
        code: CheckoutIssueCode.VARIANT_MISMATCH,
        message: 'Variant does not match the product.',
        productId: buyNowItem.productId,
        productVariantId: buyNowItem.productVariantId,
      });
    }

    // 3. Stock availability verification (when inventory service is active)
    if (
      this.inventoryService &&
      variant &&
      variant.status === ProductVariantStatus.ACTIVE &&
      product &&
      product.status === ProductStatus.ACTIVE
    ) {
      const stockBalance = await this.inventoryService.getBalance(variant.id);
      if (stockBalance.available < buyNowItem.quantity) {
        issues.push({
          code: CheckoutIssueCode.INSUFFICIENT_STOCK,
          message: `Insufficient stock for "${product.name} (${variant.name})". Available: ${stockBalance.available}, Requested: ${buyNowItem.quantity}.`,
          productId: buyNowItem.productId,
          productVariantId: buyNowItem.productVariantId,
          productName: product.name,
          sku: variant.sku,
          requestedQuantity: buyNowItem.quantity,
          availableQuantity: stockBalance.available,
        });
      }
    }

    const authoritativeUnitPrice = variant?.price ?? 0;
    const authoritativeSubtotal = authoritativeUnitPrice * buyNowItem.quantity;
    const currency = variant?.currency ?? 'INR';

    // 4. Return structured issue response if any validation issue detected
    if (issues.length > 0) {
      return {
        id: '',
        userId: user.id,
        cartId: null,
        status: CheckoutStatus.CANCELLED as TypesCheckoutStatus,
        currency,
        subtotal: authoritativeSubtotal,
        totalItems: buyNowItem.quantity,
        items: [
          {
            id: '',
            checkoutSessionId: '',
            productId: buyNowItem.productId,
            productVariantId: buyNowItem.productVariantId,
            productName: product?.name ?? 'Unknown Product',
            variantName: variant?.name ?? 'Unknown Variant',
            productSku: variant?.sku ?? '',
            quantity: buyNowItem.quantity,
            unitPrice: authoritativeUnitPrice,
            lineTotal: authoritativeSubtotal,
            currency,
            primaryImageUrl: product?.media?.[0]?.url ?? null,
            createdAt: now.toISOString(),
          },
        ],
        isValid: false,
        issues,
        idempotencyKey: idempotencyKey ?? null,
        expiresAt: new Date(
          now.getTime() + DEFAULT_CHECKOUT_SESSION_EXPIRY_MINUTES * 60 * 1000,
        ).toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    }

    // 5. Existing Active Buy Now Session Check:
    // Look for an existing, non-expired ACTIVE session for this user with cartId: null.
    // Notice: Cart-based checkout sessions (cartId !== null) are completely untouched.
    const existingBuyNowSession = await this.prisma.checkoutSession.findFirst({
      where: {
        userId: user.id,
        cartId: null,
        status: CheckoutStatus.ACTIVE,
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    if (existingBuyNowSession) {
      if (existingBuyNowSession.expiresAt <= now) {
        await this.prisma.checkoutSession.update({
          where: { id: existingBuyNowSession.id },
          data: { status: CheckoutStatus.EXPIRED },
        });
        if (this.inventoryService) {
          await this.inventoryService.releaseReservation(
            existingBuyNowSession.id,
            user.id,
            'Checkout session expired',
          );
        }
      } else {
        const itemMatches =
          existingBuyNowSession.items.length === 1 &&
          existingBuyNowSession.items[0]?.productVariantId === variant!.id &&
          existingBuyNowSession.items[0]?.quantity === buyNowItem.quantity &&
          existingBuyNowSession.items[0]?.unitPrice === variant!.price;

        if (itemMatches) {
          if (!idempotencyKey || existingBuyNowSession.idempotencyKey === idempotencyKey) {
            if (shippingAddress) {
              const addressMatches =
                existingBuyNowSession.shippingName === (shippingAddress.name ?? null) &&
                existingBuyNowSession.shippingPhone === (shippingAddress.phone ?? null) &&
                existingBuyNowSession.shippingLine1 === (shippingAddress.line1 ?? null) &&
                existingBuyNowSession.shippingLine2 === (shippingAddress.line2 ?? null) &&
                existingBuyNowSession.shippingCity === (shippingAddress.city ?? null) &&
                existingBuyNowSession.shippingState === (shippingAddress.state ?? null) &&
                existingBuyNowSession.shippingPostalCode === (shippingAddress.postalCode ?? null) &&
                existingBuyNowSession.shippingCountry === (shippingAddress.country ?? null);

              if (!addressMatches) {
                const capturedPayment = await this.prisma.paymentAttempt.findFirst({
                  where: {
                    checkoutSessionId: existingBuyNowSession.id,
                    status: PaymentStatus.CAPTURED,
                  },
                });
                if (capturedPayment) {
                  throw new ConflictException({
                    code: 'PAYMENT_ALREADY_CAPTURED',
                    message:
                      'Cannot update checkout session shipping address after payment has been captured.',
                    paymentAttemptId: capturedPayment.id,
                  });
                }

                const updated = await this.prisma.checkoutSession.update({
                  where: { id: existingBuyNowSession.id },
                  data: {
                    shippingName: shippingAddress.name ?? null,
                    shippingPhone: shippingAddress.phone ?? null,
                    shippingLine1: shippingAddress.line1 ?? null,
                    shippingLine2: shippingAddress.line2 ?? null,
                    shippingCity: shippingAddress.city ?? null,
                    shippingState: shippingAddress.state ?? null,
                    shippingPostalCode: shippingAddress.postalCode ?? null,
                    shippingCountry: shippingAddress.country ?? null,
                  },
                  include: { items: true },
                });
                return this.mapToDto(updated, true, []);
              }
            }
            return this.mapToDto(existingBuyNowSession, true, []);
          }
        }

        // Active Buy Now item changed or new idempotency key:
        // Payment boundary guard: cannot cancel if payment attempt is in progress!
        const activePayment = await this.prisma.paymentAttempt.findFirst({
          where: {
            checkoutSessionId: existingBuyNowSession.id,
            status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
          },
        });
        if (activePayment) {
          throw new ConflictException({
            code: 'ACTIVE_PAYMENT_EXISTS',
            message:
              'An active payment attempt is already in progress for this checkout session.',
            paymentAttemptId: activePayment.id,
          });
        }

        await this.prisma.checkoutSession.update({
          where: { id: existingBuyNowSession.id },
          data: { status: CheckoutStatus.CANCELLED },
        });

        if (this.inventoryService) {
          await this.inventoryService.releaseReservation(
            existingBuyNowSession.id,
            user.id,
            'Checkout session replaced or cancelled due to new Buy Now selection',
          );
        }
      }
    }

    // 6. Create new authoritative Buy Now checkout session with cartId: null
    const expiresAt = new Date(
      now.getTime() + DEFAULT_CHECKOUT_SESSION_EXPIRY_MINUTES * 60 * 1000,
    );

    try {
      const session = await this.prisma.$transaction(async (tx) => {
        const createdSession = await tx.checkoutSession.create({
          data: {
            userId: user.id,
            cartId: null, // Buy Now session has cartId: null
            status: CheckoutStatus.ACTIVE,
            currency,
            subtotal: authoritativeSubtotal,
            idempotencyKey: idempotencyKey ?? null,
            expiresAt,
            shippingName: shippingAddress?.name ?? null,
            shippingPhone: shippingAddress?.phone ?? null,
            shippingLine1: shippingAddress?.line1 ?? null,
            shippingLine2: shippingAddress?.line2 ?? null,
            shippingCity: shippingAddress?.city ?? null,
            shippingState: shippingAddress?.state ?? null,
            shippingPostalCode: shippingAddress?.postalCode ?? null,
            shippingCountry: shippingAddress?.country ?? null,
            items: {
              create: [
                {
                  productId: product!.id,
                  productVariantId: variant!.id,
                  productName: product!.name,
                  variantName: variant!.name,
                  productSku: variant!.sku,
                  quantity: buyNowItem.quantity,
                  unitPrice: authoritativeUnitPrice,
                  lineTotal: authoritativeSubtotal,
                  currency,
                  primaryImageUrl: product!.media[0]?.url ?? null,
                },
              ],
            },
          },
          include: { items: true },
        });

        if (this.inventoryService) {
          await this.inventoryService.reserveStock(
            {
              checkoutSessionId: createdSession.id,
              items: [
                {
                  variantId: variant!.id,
                  quantity: buyNowItem.quantity,
                },
              ],
              expiresAt,
              actorId: user.id,
            },
            tx,
          );
        }

        return createdSession;
      });

      await this.auditService.logEvent({
        actorId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        action: AuditAction.CHECKOUT_INITIALIZED,
        entityType: AuditEntityType.CHECKOUT,
        entityId: session.id,
        metadata: {
          amount: authoritativeSubtotal,
          currency: session.currency,
          cartId: null,
          isBuyNow: true,
          productId: product!.id,
          variantId: variant!.id,
          quantity: buyNowItem.quantity,
          itemCount: 1,
          idempotencyKey: session.idempotencyKey,
          expiresAt: session.expiresAt.toISOString(),
        },
      });

      return this.mapToDto(session, true, []);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        if (idempotencyKey) {
          const concurrentByKey = await this.prisma.checkoutSession.findUnique({
            where: {
              userId_idempotencyKey: {
                userId: user.id,
                idempotencyKey,
              },
            },
            include: { items: true },
          });
          if (concurrentByKey) {
            return this.mapToDto(concurrentByKey, true, []);
          }
        }
      }
      throw error;
    }
  }

  /**
   * Retrieves an authoritative checkout session by ID with ownership and expiration checks.
   */
  async getCheckoutSession(
    sessionId: string,
    user: MinimalUser,
  ): Promise<CheckoutSessionDto> {
    await this.assertFeatureEnabled(user);

    const session = await this.prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: {
        items: true,
      },
    });

    if (!session) {
      throw new NotFoundException(`Checkout session '${sessionId}' not found`);
    }

    // Security check: IDOR protection. Checkout sessions are strictly customer-owned.
    if (session.userId !== user.id) {
      await this.auditService.logEvent({
        actorId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        action: AuditAction.CHECKOUT_SECURITY_VIOLATION,
        entityType: AuditEntityType.CHECKOUT,
        entityId: sessionId,
        metadata: {
          attemptedBy: user.id,
          ownerId: session.userId,
          reason: 'Unauthorized access to customer checkout session',
        },
      });
      throw new ForbiddenException(
        'You do not have access to this checkout session',
      );
    }

    // Expiration check
    const now = new Date();
    if (session.status === CheckoutStatus.EXPIRED || session.expiresAt <= now) {
      if (session.status === CheckoutStatus.ACTIVE) {
        await this.prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: CheckoutStatus.EXPIRED },
        });
        session.status = CheckoutStatus.EXPIRED;

        await this.auditService.logEvent({
          actorId: user.id,
          actorRole: user.role,
          actorEmail: user.email,
          action: AuditAction.CHECKOUT_EXPIRED,
          entityType: AuditEntityType.CHECKOUT,
          entityId: session.id,
          metadata: {
            expiredAt: session.expiresAt.toISOString(),
          },
        });
      }
      return this.mapToDto(session, false, [
        {
          code: CheckoutIssueCode.SESSION_EXPIRED,
          message:
            'This checkout session has expired. Please revalidate or start a new checkout.',
        },
      ]);
    }

    // Batched revalidation check for current catalog state
    const productIds = Array.from(
      new Set(session.items.map((i) => i.productId)),
    );
    const variantIds = Array.from(
      new Set(session.items.map((i) => i.productVariantId)),
    );

    const [products, variants] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
      }),
      this.prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
      }),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const issues: CheckoutValidationIssue[] = [];

    for (const item of session.items) {
      const product = productMap.get(item.productId);
      if (!product || product.status !== ProductStatus.ACTIVE) {
        issues.push({
          code: CheckoutIssueCode.PRODUCT_UNAVAILABLE,
          message: `Product "${item.productName}" is no longer available.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          productName: item.productName,
        });
        continue;
      }

      const variant = variantMap.get(item.productVariantId);
      if (!variant || variant.status !== ProductVariantStatus.ACTIVE) {
        issues.push({
          code: CheckoutIssueCode.VARIANT_UNAVAILABLE,
          message: `Variant "${item.productSku}" is no longer available.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          productName: item.productName,
          sku: item.productSku,
        });
        continue;
      }

      if (variant.price !== item.unitPrice) {
        issues.push({
          code: CheckoutIssueCode.PRICE_CHANGED,
          message: `Price for "${item.productName}" changed from ₹${(item.unitPrice / 100).toFixed(2)} to ₹${(variant.price / 100).toFixed(2)}.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          productName: item.productName,
          sku: item.productSku,
          previousPrice: item.unitPrice,
          currentPrice: variant.price,
        });
      }
    }

    const isValid =
      issues.length === 0 && session.status === CheckoutStatus.ACTIVE;
    return this.mapToDto(session, isValid, issues);
  }

  /**
   * Revalidates an existing checkout session against the live catalog and cart state.
   */
  async revalidateCheckout(
    sessionId: string,
    user: MinimalUser,
  ): Promise<RevalidateCheckoutResultDto> {
    return this.revalidateCheckoutSession(sessionId, user);
  }

  async revalidateCheckoutSession(
    sessionId: string,
    user: MinimalUser,
  ): Promise<RevalidateCheckoutResultDto> {
    await this.assertFeatureEnabled(user);

    const session = await this.prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: {
        items: true,
      },
    });

    if (!session) {
      throw new NotFoundException(`Checkout session '${sessionId}' not found`);
    }

    // IDOR protection
    if (session.userId !== user.id) {
      throw new ForbiddenException(
        'You do not have access to this checkout session',
      );
    }

    // Check expiration
    const now = new Date();
    if (session.status === CheckoutStatus.EXPIRED || session.expiresAt <= now) {
      if (session.status === CheckoutStatus.ACTIVE) {
        await this.prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: CheckoutStatus.EXPIRED },
        });
        session.status = CheckoutStatus.EXPIRED;
      }
      return {
        session: this.mapToDto(session, false, [
          {
            code: CheckoutIssueCode.SESSION_EXPIRED,
            message: 'Checkout session has expired.',
          },
        ]),
        isValid: false,
        issues: [
          {
            code: CheckoutIssueCode.SESSION_EXPIRED,
            message: 'Checkout session has expired.',
          },
        ],
      };
    }

    // Batched re-check of catalog state for all items in the snapshot
    const productIds = Array.from(
      new Set(session.items.map((i) => i.productId)),
    );
    const variantIds = Array.from(
      new Set(session.items.map((i) => i.productVariantId)),
    );

    const [products, variants] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
      }),
      this.prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
      }),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const variantMap = new Map(variants.map((v) => [v.id, v]));

    const issues: CheckoutValidationIssue[] = [];

    for (const item of session.items) {
      const product = productMap.get(item.productId);
      if (!product || product.status !== ProductStatus.ACTIVE) {
        issues.push({
          code: CheckoutIssueCode.PRODUCT_UNAVAILABLE,
          message: `Product "${item.productName}" is no longer active.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          productName: item.productName,
        });
        continue;
      }

      const variant = variantMap.get(item.productVariantId);
      if (!variant || variant.status !== ProductVariantStatus.ACTIVE) {
        issues.push({
          code: CheckoutIssueCode.VARIANT_UNAVAILABLE,
          message: `Variant "${item.productSku}" is no longer active.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          productName: item.productName,
          sku: item.productSku,
        });
        continue;
      }

      if (variant.price !== item.unitPrice) {
        issues.push({
          code: CheckoutIssueCode.PRICE_CHANGED,
          message: `Price for "${item.productName}" changed from ₹${(item.unitPrice / 100).toFixed(2)} to ₹${(variant.price / 100).toFixed(2)}.`,
          productId: item.productId,
          productVariantId: item.productVariantId,
          productName: item.productName,
          sku: item.productSku,
          previousPrice: item.unitPrice,
          currentPrice: variant.price,
        });
      }
    }

    // Check if user's active cart has changed since checkout was initialized
    // Only applies to cart-based checkout sessions (cartId !== null).
    // Buy Now sessions (cartId: null) do not have an associated cart and must not fail on cart parity.
    if (session.cartId !== null) {
      const activeCart = await this.prisma.cart.findFirst({
        where: {
          userId: user.id,
          status: CartStatus.ACTIVE,
        },
        include: {
          items: true,
        },
      });

      if (!activeCart || activeCart.items.length !== session.items.length) {
        issues.push({
          code: CheckoutIssueCode.CART_CHANGED,
          message:
            'Your cart items have changed since this checkout session was created.',
        });
      } else {
        const cartMatches = session.items.every((si) =>
          activeCart.items.some(
            (ci) =>
              ci.productVariantId === si.productVariantId &&
              ci.quantity === si.quantity,
          ),
        );
        if (!cartMatches) {
          issues.push({
            code: CheckoutIssueCode.CART_CHANGED,
            message:
              'Your cart items or quantities have changed since checkout initialization.',
          });
        }
      }
    }

    // Verify inventory reservations remain valid and active if inventory is wired up
    if (this.inventoryService && this.prisma.inventoryReservation) {
      const reservations = await this.prisma.inventoryReservation.findMany({
        where: {
          checkoutSessionId: session.id,
          status: ReservationStatus.PENDING,
        },
      });
      const resMap = new Map(reservations.map((r) => [r.variantId, r]));
      for (const item of session.items) {
        const res = resMap.get(item.productVariantId);
        if (!res || res.expiresAt <= now || res.quantity < item.quantity) {
          issues.push({
            code: CheckoutIssueCode.INSUFFICIENT_STOCK,
            message: `Stock reservation for "${item.productName}" is expired or unavailable.`,
            productId: item.productId,
            productVariantId: item.productVariantId,
            sku: item.productSku,
            requestedQuantity: item.quantity,
          });
        }
      }
    }

    const isValid =
      issues.length === 0 && session.status === CheckoutStatus.ACTIVE;
    return {
      session: this.mapToDto(session, isValid, issues),
      isValid,
      issues,
    };
  }

  /**
   * Authoritative Pre-Payment Boundary.
   *
   * Future Payment creation MUST call this method to obtain the authoritative
   * payable amount. Payment MUST NOT trust checkoutSession.subtotal directly.
   *
   * Verifies:
   * 1. User authentication & strict ownership
   * 2. CHECKOUT feature flag status
   * 3. Session status is ACTIVE
   * 4. Session has not expired
   * 5. Current catalog prices, availability, and active cart parity
   *
   * Rejects if any price change, unavailable item, or cart mutation is detected.
   */
  async assertCheckoutReadyForPayment(
    sessionId: string,
    user: MinimalUser,
  ): Promise<{
    session: CheckoutSessionDto;
    payableAmount: number;
    currency: string;
  }> {
    await this.assertFeatureEnabled(user);

    const session = await this.prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: { items: true },
    });

    if (!session) {
      throw new NotFoundException(`Checkout session '${sessionId}' not found`);
    }

    // IDOR protection: only session owner can pay
    if (session.userId !== user.id) {
      await this.auditService.logEvent({
        actorId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        action: AuditAction.CHECKOUT_SECURITY_VIOLATION,
        entityType: AuditEntityType.CHECKOUT,
        entityId: sessionId,
        metadata: {
          attemptedBy: user.id,
          ownerId: session.userId,
          reason: 'Unauthorized payment attempt on customer checkout session',
        },
      });
      throw new ForbiddenException(
        'You do not have permission to pay for this checkout session',
      );
    }

    // Status check
    if (session.status !== CheckoutStatus.ACTIVE) {
      throw new BadRequestException({
        code: CheckoutIssueCode.SESSION_EXPIRED,
        message: `Checkout session cannot be paid because its status is ${session.status}.`,
      });
    }

    // Expiration check
    if (session.expiresAt <= new Date()) {
      await this.prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: CheckoutStatus.EXPIRED },
      });
      await this.auditService.logEvent({
        actorId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        action: AuditAction.CHECKOUT_EXPIRED,
        entityType: AuditEntityType.CHECKOUT,
        entityId: session.id,
        metadata: {
          expiredAt: session.expiresAt.toISOString(),
          attemptedPayment: true,
        },
      });
      throw new BadRequestException({
        code: CheckoutIssueCode.SESSION_EXPIRED,
        message:
          'Checkout session has expired. Please revalidate your checkout before paying.',
      });
    }

    // Authoritative revalidation check
    const revalidation = await this.revalidateCheckoutSession(sessionId, user);

    if (!revalidation.isValid || revalidation.issues.length > 0) {
      throw new BadRequestException({
        code: 'CHECKOUT_VALIDATION_FAILED',
        message:
          'Checkout items or prices have changed and require customer re-review before payment.',
        issues: revalidation.issues,
      });
    }

    return {
      session: revalidation.session,
      payableAmount: session.subtotal,
      currency: session.currency,
    };
  }

  /**
   * Cancels an active checkout session.
   */
  async cancelCheckout(
    sessionId: string,
    user: MinimalUser,
  ): Promise<CheckoutSessionDto> {
    await this.assertFeatureEnabled(user);

    const session = await this.prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: { items: true },
    });

    if (!session) {
      throw new NotFoundException(`Checkout session '${sessionId}' not found`);
    }

    if (session.userId !== user.id) {
      throw new ForbiddenException(
        'You do not have access to this checkout session',
      );
    }

    // Payment boundary freeze: cannot cancel checkout session while an active payment attempt exists
    const activePayment = await this.prisma.paymentAttempt.findFirst({
      where: {
        checkoutSessionId: sessionId,
        status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
      },
    });
    if (activePayment) {
      throw new ConflictException({
        code: 'ACTIVE_PAYMENT_EXISTS',
        message:
          'Cannot cancel checkout session while an active payment attempt is in progress.',
        paymentAttemptId: activePayment.id,
      });
    }

    const updated = await this.prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { status: CheckoutStatus.CANCELLED },
      include: { items: true },
    });

    if (this.inventoryService) {
      await this.inventoryService.releaseReservation(
        sessionId,
        user.id,
        'Customer cancelled checkout session',
      );
    }

    await this.auditService.logEvent({
      actorId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      action: AuditAction.CHECKOUT_CANCELLED,
      entityType: AuditEntityType.CHECKOUT,
      entityId: sessionId,
      metadata: {
        amount: updated.subtotal,
        currency: updated.currency,
      },
    });

    return this.mapToDto(updated, false, []);
  }

  /**
   * Mutates the shipping address snapshot on an active CheckoutSession.
   *
   * PAYMENT BOUNDARY FREEZE:
   * - Blocked if an active PaymentAttempt (CREATED or PENDING) exists.
   * - Blocked if a CAPTURED PaymentAttempt exists.
   * - Blocked if session is not ACTIVE or has expired.
   */
  async updateShippingAddress(
    sessionId: string,
    user: MinimalUser,
    shippingAddress: ShippingAddressDto,
  ): Promise<CheckoutSessionDto> {
    await this.assertFeatureEnabled(user);

    const session = await this.prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: { items: true },
    });

    if (!session) {
      throw new NotFoundException(`Checkout session '${sessionId}' not found`);
    }

    if (session.userId !== user.id) {
      throw new ForbiddenException(
        'You do not have access to this checkout session',
      );
    }

    if (session.status !== CheckoutStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'CHECKOUT_NOT_ACTIVE',
        message: `Cannot update shipping address for checkout session in ${session.status} status.`,
      });
    }

    if (session.expiresAt <= new Date()) {
      throw new BadRequestException({
        code: CheckoutIssueCode.SESSION_EXPIRED,
        message: 'Checkout session has expired.',
      });
    }

    // ── Payment Boundary Freeze ──────────────────────────────────────────────
    // 1. Block if an active payment attempt is in flight
    const activePayment = await this.prisma.paymentAttempt.findFirst({
      where: {
        checkoutSessionId: sessionId,
        status: { in: [PaymentStatus.CREATED, PaymentStatus.PENDING] },
      },
    });

    if (activePayment) {
      throw new ConflictException({
        code: 'ACTIVE_PAYMENT_EXISTS',
        message:
          'Cannot update shipping address while an active payment attempt is in progress.',
        paymentAttemptId: activePayment.id,
      });
    }

    // 2. Block if payment has already been captured
    const capturedPayment = await this.prisma.paymentAttempt.findFirst({
      where: {
        checkoutSessionId: sessionId,
        status: PaymentStatus.CAPTURED,
      },
    });

    if (capturedPayment) {
      throw new ConflictException({
        code: 'PAYMENT_ALREADY_CAPTURED',
        message:
          'Cannot update shipping address after payment has been captured.',
        paymentAttemptId: capturedPayment.id,
      });
    }

    // Apply immutable shipping address snapshot
    const updated = await this.prisma.checkoutSession.update({
      where: { id: sessionId },
      data: {
        shippingName:       shippingAddress.name       ?? null,
        shippingPhone:      shippingAddress.phone      ?? null,
        shippingLine1:      shippingAddress.line1      ?? null,
        shippingLine2:      shippingAddress.line2      ?? null,
        shippingCity:       shippingAddress.city       ?? null,
        shippingState:      shippingAddress.state      ?? null,
        shippingPostalCode: shippingAddress.postalCode ?? null,
        shippingCountry:    shippingAddress.country    ?? null,
      },
      include: { items: true },
    });

    return this.mapToDto(updated, true, []);
  }

  /**
   * Transforms database Prisma model to CheckoutSessionDto.
   */
  private mapToDto(
    session: CheckoutSessionWithItems,
    isValid: boolean,
    issues: CheckoutValidationIssue[],
  ): CheckoutSessionDto {
    const totalItems = session.items.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    return {
      id: session.id,
      userId: session.userId,
      cartId: session.cartId ?? null,
      status: session.status as TypesCheckoutStatus,
      currency: session.currency,
      subtotal: session.subtotal,
      totalItems,
      items: session.items.map((item) => this.mapItemToDto(item)),
      isValid,
      issues,
      shippingAddress: session.shippingLine1
        ? {
            name: session.shippingName ?? null,
            phone: session.shippingPhone ?? null,
            line1: session.shippingLine1 ?? null,
            line2: session.shippingLine2 ?? null,
            city: session.shippingCity ?? null,
            state: session.shippingState ?? null,
            postalCode: session.shippingPostalCode ?? null,
            country: session.shippingCountry ?? null,
          }
        : null,
      idempotencyKey: session.idempotencyKey ?? null,
      expiresAt: session.expiresAt.toISOString(),
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  private mapItemToDto(
    item: CheckoutSessionWithItems['items'][number],
  ): CheckoutItemSnapshotDto {
    return {
      id: item.id,
      checkoutSessionId: item.checkoutSessionId,
      productId: item.productId,
      productVariantId: item.productVariantId,
      productName: item.productName,
      variantName: item.variantName,
      productSku: item.productSku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      currency: item.currency,
      primaryImageUrl: item.primaryImageUrl,
      createdAt: item.createdAt.toISOString(),
    };
  }
}
