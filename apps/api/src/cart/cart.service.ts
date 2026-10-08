import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  DEFAULT_MAX_CART_ITEM_QUANTITY,
  GUEST_CART_EXPIRY_DAYS,
  AuditAction,
  AuditEntityType,
  type CartSummaryDto,
  type CartItemDto,
  type AddToCartDto,
  type MergeCartResultDto,
  type CartStatus as TypesCartStatus,
  type ProductStatus as TypesProductStatus,
  type ProductVariantStatus as TypesVariantStatus,
} from '@vishkaraa/types';
import {
  CartStatus,
  Prisma,
  ProductVariant,
} from '@prisma/client';

export interface CartActor {
  userId?: string;
  guestToken?: string;
  userRole?: string;
  userEmail?: string;
}

export interface GetCartResult {
  cart: CartSummaryDto;
  rawGuestToken?: string;
}

const CART_INCLUDE = {
  items: {
    include: {
      product: {
        include: {
          media: {
            where: { isPrimary: true },
            take: 1,
          },
        },
      },
      productVariant: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.CartInclude;

type CartWithRelations = Prisma.CartGetPayload<{
  include: typeof CART_INCLUDE;
}>;

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // ─── Token Utilities ────────────────────────────────────────────────────────

  /**
   * Generates a cryptographically random guest token (256-bit entropy).
   */
  generateGuestToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generates SHA-256 hash of a guest token for secure database storage.
   */
  hashGuestToken(token: string): string {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
  }

  // ─── Quantity Validation ───────────────────────────────────────────────────

  /**
   * Centralized cart quantity rule:
   * Must be integer, > 0, and <= DEFAULT_MAX_CART_ITEM_QUANTITY.
   */
  validateQuantity(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer greater than 0');
    }
    if (quantity > DEFAULT_MAX_CART_ITEM_QUANTITY) {
      throw new BadRequestException(
        `Quantity cannot exceed the maximum limit of ${DEFAULT_MAX_CART_ITEM_QUANTITY} per item`,
      );
    }
  }

  // ─── Cart Retrieval & Initialization ────────────────────────────────────────

  /**
   * Get or initialize a cart for either an authenticated user or a guest visitor.
   */
  async getOrCreateCart(actor: CartActor): Promise<GetCartResult> {
    // 1. Authenticated User Cart
    if (actor.userId) {
      let userCart = await this.prisma.cart.findFirst({
        where: { userId: actor.userId, status: CartStatus.ACTIVE },
        include: CART_INCLUDE,
      });

      if (!userCart) {
        try {
          userCart = await this.prisma.cart.create({
            data: {
              userId: actor.userId,
              status: CartStatus.ACTIVE,
              currency: 'INR',
            },
            include: CART_INCLUDE,
          });
        } catch (error: unknown) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            userCart = await this.prisma.cart.findFirst({
              where: { userId: actor.userId, status: CartStatus.ACTIVE },
              include: CART_INCLUDE,
            });
            if (!userCart) throw error;
          } else {
            throw error;
          }
        }
      }

      return { cart: this.toSummaryDto(userCart) };
    }

    // 2. Existing Guest Cart via Token
    if (actor.guestToken) {
      const tokenHash = this.hashGuestToken(actor.guestToken);
      const guestCart = await this.prisma.cart.findFirst({
        where: {
          guestTokenHash: tokenHash,
          status: CartStatus.ACTIVE,
        },
        include: CART_INCLUDE,
      });

      if (guestCart) {
        // Verify not expired
        if (!guestCart.expiresAt || guestCart.expiresAt > new Date()) {
          return { cart: this.toSummaryDto(guestCart, actor.guestToken) };
        }
      }
    }

    // 3. New Guest Cart Initialization
    const rawToken = this.generateGuestToken();
    const tokenHash = this.hashGuestToken(rawToken);
    const expiresAt = new Date(Date.now() + GUEST_CART_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const newCart = await this.prisma.cart.create({
      data: {
        status: CartStatus.ACTIVE,
        currency: 'INR',
        guestTokenHash: tokenHash,
        expiresAt,
      },
      include: CART_INCLUDE,
    });

    return {
      cart: this.toSummaryDto(newCart, rawToken),
      rawGuestToken: rawToken,
    };
  }

  /**
   * Resolves the active cart for an actor, verifying ownership.
   */
  private async resolveActiveCart(actor: CartActor, autoCreate = false): Promise<{ cart: CartWithRelations; rawToken?: string }> {
    if (actor.userId) {
      let cart = await this.prisma.cart.findFirst({
        where: { userId: actor.userId, status: CartStatus.ACTIVE },
        include: CART_INCLUDE,
      });

      if (!cart) {
        if (!autoCreate) {
          throw new NotFoundException('Active cart not found');
        }
        try {
          cart = await this.prisma.cart.create({
            data: {
              userId: actor.userId,
              status: CartStatus.ACTIVE,
              currency: 'INR',
            },
            include: CART_INCLUDE,
          });
        } catch (error: unknown) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            cart = await this.prisma.cart.findFirst({
              where: { userId: actor.userId, status: CartStatus.ACTIVE },
              include: CART_INCLUDE,
            });
            if (!cart) throw error;
          } else {
            throw error;
          }
        }
      }

      return { cart };
    }

    if (actor.guestToken) {
      const tokenHash = this.hashGuestToken(actor.guestToken);
      const cart = await this.prisma.cart.findFirst({
        where: { guestTokenHash: tokenHash, status: CartStatus.ACTIVE },
        include: CART_INCLUDE,
      });

      if (cart) {
        if (cart.expiresAt && cart.expiresAt <= new Date()) {
          throw new ForbiddenException('Guest cart has expired');
        }
        return { cart, rawToken: actor.guestToken };
      }
    }

    if (autoCreate) {
      const rawToken = this.generateGuestToken();
      const tokenHash = this.hashGuestToken(rawToken);
      const expiresAt = new Date(Date.now() + GUEST_CART_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      const cart = await this.prisma.cart.create({
        data: {
          status: CartStatus.ACTIVE,
          currency: 'INR',
          guestTokenHash: tokenHash,
          expiresAt,
        },
        include: CART_INCLUDE,
      });

      return { cart, rawToken };
    }

    throw new ForbiddenException('Valid cart token or authentication required');
  }

  // ─── Cart Operations ────────────────────────────────────────────────────────

  /**
   * Add an item to the cart.
   *
   * Security & Business Rules:
   * - Product must exist and have status === 'ACTIVE'
   * - Variant must exist, belong to productId, and have status === 'ACTIVE'
   * - Client cannot supply prices. Price snapshot is read from authoritative ProductVariant.price.
   * - Quantity must be integer between 1 and MAX_CART_ITEM_QUANTITY.
   * - If variant already in cart, increment quantity up to MAX limit (idempotent / no duplicate rows).
   */
  async addItem(actor: CartActor, dto: AddToCartDto): Promise<GetCartResult> {
    this.validateQuantity(dto.quantity);

    // 1. Authoritative Catalog Validation
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (product.status !== 'ACTIVE') {
      throw new BadRequestException('Product is not active or available for purchase');
    }

    let variant: ProductVariant | null = null;
    if (dto.productVariantId && dto.productVariantId !== dto.productId) {
      variant = await this.prisma.productVariant.findUnique({
        where: { id: dto.productVariantId },
      });
      if (!variant) {
        throw new NotFoundException('Product variant not found');
      }
      if (variant.productId !== dto.productId) {
        throw new BadRequestException('Variant does not belong to specified product');
      }
    } else {
      variant = await this.prisma.productVariant.findFirst({
        where: {
          productId: dto.productId,
          status: 'ACTIVE',
        },
        orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
      });
      if (!variant) {
        throw new NotFoundException('Product variant not found or not active');
      }
    }

    if (variant.status !== 'ACTIVE') {
      throw new BadRequestException('Product variant is not active or available for purchase');
    }

    // 2. Resolve or create active cart
    const { cart, rawToken } = await this.resolveActiveCart(actor, true);

    // 3. Atomically upsert/merge variant in cart
    await this.prisma.$transaction(async (tx) => {
      const existingItem = await tx.cartItem.findUnique({
        where: {
          cartId_productVariantId: {
            cartId: cart.id,
            productVariantId: variant.id,
          },
        },
      });

      if (existingItem) {
        const newQuantity = existingItem.quantity + dto.quantity;
        if (newQuantity > DEFAULT_MAX_CART_ITEM_QUANTITY) {
          throw new BadRequestException(
            `Cannot add ${dto.quantity} items. Cart limit is ${DEFAULT_MAX_CART_ITEM_QUANTITY} per item (currently in cart: ${existingItem.quantity})`,
          );
        }

        await tx.cartItem.update({
          where: { id: existingItem.id },
          data: {
            quantity: newQuantity,
            unitPrice: variant.price, // Refresh snapshot to current catalog price
          },
        });
      } else {
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId: product.id,
            productVariantId: variant.id,
            quantity: dto.quantity,
            unitPrice: variant.price, // Authoritative price snapshot
            currency: variant.currency || 'INR',
          },
        });
      }
    });

    // 4. Return updated cart summary
    const updatedCart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cart.id },
      include: CART_INCLUDE,
    });

    return {
      cart: this.toSummaryDto(updatedCart, rawToken ?? actor.guestToken),
      rawGuestToken: rawToken,
    };
  }

  /**
   * Update the quantity of an existing cart item.
   */
  async updateItemQuantity(actor: CartActor, itemId: string, quantity: number): Promise<CartSummaryDto> {
    this.validateQuantity(quantity);

    const { cart } = await this.resolveActiveCart(actor, false);

    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { productVariant: true },
    });

    if (!item || item.cartId !== cart.id) {
      throw new NotFoundException('Cart item not found');
    }

    // Refresh authoritative price if variant exists
    const currentPrice = item.productVariant?.price ?? item.unitPrice;

    await this.prisma.cartItem.update({
      where: { id: itemId },
      data: {
        quantity,
        unitPrice: currentPrice,
      },
    });

    const updatedCart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cart.id },
      include: CART_INCLUDE,
    });

    return this.toSummaryDto(updatedCart, actor.guestToken);
  }

  /**
   * Remove a single item from the cart.
   */
  async removeItem(actor: CartActor, itemId: string): Promise<CartSummaryDto> {
    const { cart } = await this.resolveActiveCart(actor, false);

    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
    });

    if (!item || item.cartId !== cart.id) {
      throw new NotFoundException('Cart item not found');
    }

    await this.prisma.cartItem.delete({
      where: { id: itemId },
    });

    const updatedCart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cart.id },
      include: CART_INCLUDE,
    });

    return this.toSummaryDto(updatedCart, actor.guestToken);
  }

  /**
   * Clear all items in the cart.
   */
  async clearCart(actor: CartActor): Promise<CartSummaryDto> {
    const { cart } = await this.resolveActiveCart(actor, false);

    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });

    const updatedCart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cart.id },
      include: CART_INCLUDE,
    });

    return this.toSummaryDto(updatedCart, actor.guestToken);
  }

  // ─── Guest → User Cart Merge ────────────────────────────────────────────────

  /**
   * Merges an anonymous guest cart into an authenticated user's cart.
   *
   * Business & Security Rules:
   * - Must be invoked by an authenticated USER
   * - Guest token is hashed and verified
   * - Inactive or unavailable items are omitted with structured warnings
   * - Duplicate variants combine quantities up to DEFAULT_MAX_CART_ITEM_QUANTITY
   * - Prices are refreshed to current catalog values
   * - Guest cart is marked MERGED and cannot be replayed
   * - Security violation is logged if replay or illegal ownership is attempted
   */
  async mergeGuestCart(userId: string, guestToken: string): Promise<MergeCartResultDto> {
    if (!guestToken || typeof guestToken !== 'string') {
      throw new BadRequestException('Valid guest cart token is required for merge');
    }

    const tokenHash = this.hashGuestToken(guestToken);

    // 1. Find Guest Cart
    const guestCart = await this.prisma.cart.findFirst({
      where: { guestTokenHash: tokenHash },
      include: {
        items: {
          include: {
            product: true,
            productVariant: true,
          },
        },
      },
    });

    if (!guestCart) {
      throw new NotFoundException('Guest cart not found');
    }

    // Replay protection: already merged carts cannot be re-merged
    if (guestCart.status === CartStatus.MERGED) {
      this.logger.warn(`Cart merge replay attempted on already-merged cart ${guestCart.id} by user ${userId}`);
      await this.auditService.logEvent({
        actorId: userId,
        actorRole: 'USER',
        action: AuditAction.CART_MERGE_FAILED,
        entityType: AuditEntityType.CART,
        entityId: guestCart.id,
        reason: 'Attempted to replay merge on already-merged guest cart',
      });
      throw new ConflictException('Guest cart has already been merged');
    }

    if (guestCart.status !== CartStatus.ACTIVE) {
      throw new BadRequestException(`Cannot merge cart with status ${guestCart.status}`);
    }

    // If guest cart is already bound to another user
    if (guestCart.userId && guestCart.userId !== userId) {
      this.logger.warn(`Security violation: user ${userId} attempted to merge cart ${guestCart.id} owned by ${guestCart.userId}`);
      await this.auditService.logEvent({
        actorId: userId,
        actorRole: 'USER',
        action: AuditAction.CART_SECURITY_VIOLATION,
        entityType: AuditEntityType.CART,
        entityId: guestCart.id,
        reason: 'User attempted to merge cart belonging to a different user',
      });
      throw new ForbiddenException('Cannot merge cart belonging to another user');
    }

    // 2. Find or Create User Cart
    let userCart = await this.prisma.cart.findFirst({
      where: { userId, status: CartStatus.ACTIVE },
      include: { items: true },
    });

    if (!userCart) {
      userCart = await this.prisma.cart.create({
        data: {
          userId,
          status: CartStatus.ACTIVE,
          currency: 'INR',
        },
        include: { items: true },
      });
    }

    const warnings: string[] = [];
    let mergedCount = 0;

    // 3. Execute Merge in Transaction
    await this.prisma.$transaction(async (tx) => {
      for (const item of guestCart.items) {
        // Validate product & variant status
        const isProductActive = item.product && item.product.status === 'ACTIVE';
        const isVariantActive = item.productVariant && item.productVariant.status === 'ACTIVE';

        if (!isProductActive || !isVariantActive) {
          const itemName = item.product?.name ?? 'Unknown item';
          warnings.push(`Item "${itemName}" is no longer available and was omitted from your cart.`);
          continue;
        }

        const authoritativePrice = item.productVariant.price;
        const existingItem = await tx.cartItem.findUnique({
          where: {
            cartId_productVariantId: {
              cartId: userCart.id,
              productVariantId: item.productVariantId,
            },
          },
        });

        if (existingItem) {
          const combinedQuantity = existingItem.quantity + item.quantity;
          let finalQuantity = combinedQuantity;

          if (combinedQuantity > DEFAULT_MAX_CART_ITEM_QUANTITY) {
            finalQuantity = DEFAULT_MAX_CART_ITEM_QUANTITY;
            warnings.push(
              `Quantity for "${item.product.name} (${item.productVariant.name})" was capped at the limit of ${DEFAULT_MAX_CART_ITEM_QUANTITY}.`,
            );
          }

          await tx.cartItem.update({
            where: { id: existingItem.id },
            data: {
              quantity: finalQuantity,
              unitPrice: authoritativePrice, // Refresh to authoritative price
            },
          });
          mergedCount++;
        } else {
          let initialQuantity = item.quantity;
          if (initialQuantity > DEFAULT_MAX_CART_ITEM_QUANTITY) {
            initialQuantity = DEFAULT_MAX_CART_ITEM_QUANTITY;
            warnings.push(
              `Quantity for "${item.product.name} (${item.productVariant.name})" was capped at the limit of ${DEFAULT_MAX_CART_ITEM_QUANTITY}.`,
            );
          }

          await tx.cartItem.create({
            data: {
              cartId: userCart.id,
              productId: item.productId,
              productVariantId: item.productVariantId,
              quantity: initialQuantity,
              unitPrice: authoritativePrice, // Authoritative price snapshot
              currency: item.currency || 'INR',
            },
          });
          mergedCount++;
        }
      }

      // Mark guest cart as MERGED to prevent replay attacks
      await tx.cart.update({
        where: { id: guestCart.id },
        data: {
          status: CartStatus.MERGED,
        },
      });
    });

    // 4. Audit Log
    await this.auditService.logEvent({
      actorId: userId,
      actorRole: 'USER',
      action: AuditAction.CART_MERGED,
      entityType: AuditEntityType.CART,
      entityId: userCart.id,
      reason: `Guest cart ${guestCart.id} merged into user cart ${userCart.id} (${mergedCount} items merged)`,
    });

    // 5. Return updated user cart
    const finalUserCart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: userCart.id },
      include: CART_INCLUDE,
    });

    return {
      cart: this.toSummaryDto(finalUserCart),
      mergedCount,
      ...(warnings.length > 0 && { warnings }),
    };
  }

  // ─── Summary Formatter ──────────────────────────────────────────────────────

  /**
   * Formats a Cart entity with items into the canonical CartSummaryDto.
   *
   * Business Rules:
   * - unitPrice and lineTotal are in integer minor units (paise).
   * - lineTotal = unitPrice * quantity.
   * - Subtotal is sum of available items' line totals.
   * - Unavailable items (inactive product or variant) are clearly flagged with isAvailable: false.
   */
  private toSummaryDto(cart: CartWithRelations, guestToken?: string): CartSummaryDto {
    let subtotal = 0;
    let totalItems = 0;

    const items: CartItemDto[] = cart.items.map((item) => {
      const isAvailable =
        item.product.status === 'ACTIVE' && item.productVariant.status === 'ACTIVE';

      const lineTotal = item.unitPrice * item.quantity;
      if (isAvailable) {
        subtotal += lineTotal;
      }
      totalItems += item.quantity;

      const primaryMedia = item.product.media?.[0];

      return {
        id: item.id,
        cartId: item.cartId,
        productId: item.productId,
        productVariantId: item.productVariantId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal,
        currency: item.currency,
        isAvailable,
        product: {
          id: item.product.id,
          name: item.product.name,
          slug: item.product.slug,
          status: item.product.status as unknown as TypesProductStatus,
          primaryImage: primaryMedia
            ? {
                url: primaryMedia.url,
                altText: primaryMedia.altText,
              }
            : null,
        },
        variant: {
          id: item.productVariant.id,
          name: item.productVariant.name,
          sku: item.productVariant.sku,
          price: item.productVariant.price,
          compareAtPrice: item.productVariant.compareAtPrice,
          status: item.productVariant.status as unknown as TypesVariantStatus,
        },
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    });

    return {
      id: cart.id,
      status: cart.status as unknown as TypesCartStatus,
      currency: cart.currency,
      items,
      totalItems,
      subtotal,
      ...(guestToken && { guestToken }),
      expiresAt: cart.expiresAt ? cart.expiresAt.toISOString() : null,
      createdAt: cart.createdAt.toISOString(),
      updatedAt: cart.updatedAt.toISOString(),
    };
  }
}
