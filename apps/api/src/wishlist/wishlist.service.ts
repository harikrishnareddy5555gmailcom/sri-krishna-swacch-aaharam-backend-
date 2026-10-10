import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { WishlistItemDto } from '@vishkaraa/types';

@Injectable()
export class WishlistService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves all items in the user's wishlist with full product and variant information.
   */
  async getUserWishlist(userId: string): Promise<WishlistItemDto[]> {
    let items: Array<any> = [];
    try {
      items = await this.prisma.wishlistItem.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: {
          product: {
            include: {
              media: {
                where: { isPrimary: true },
                take: 1,
              },
              variants: {
                where: { status: 'ACTIVE' },
                orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
                include: {
                  inventoryItem: {
                    select: {
                      onHand: true,
                      reserved: true,
                      committed: true,
                    },
                  },
                },
              },
            },
          },
          variant: true,
        },
      });
    } catch (err) {
      return [];
    }

    return items.map((item) => {
      const p = item.product;
      const lowestVariant = p.variants[0];
      const primaryMedia = p.media[0];

      return {
        id: item.id,
        userId: item.userId,
        productId: item.productId,
        variantId: item.variantId,
        product: {
          id: p.id,
          name: p.name,
          slug: p.slug,
          shortDescription: p.shortDescription,
          brand: p.brand,
          primaryImage: primaryMedia
            ? { url: primaryMedia.url, altText: primaryMedia.altText ?? undefined }
            : undefined,
          fromPrice: lowestVariant?.price,
          fromCompareAtPrice: lowestVariant?.compareAtPrice ?? undefined,
          currency: lowestVariant?.currency ?? 'INR',
          isOutOfStock: p.variants.every((v: any) => {
            const inv = v.inventoryItem;
            return inv ? inv.onHand - inv.reserved - inv.committed <= 0 : false;
          }),
          variants: p.variants.map((v: any) => {
            const inv = v.inventoryItem;
            const avail = inv ? Math.max(0, inv.onHand - inv.reserved - inv.committed) : undefined;
            return {
              id: v.id,
              name: v.name,
              sku: v.sku,
              price: v.price,
              compareAtPrice: v.compareAtPrice,
              currency: v.currency,
              status: v.status,
              availableStock: avail,
              isOutOfStock: avail !== undefined ? avail <= 0 : false,
            };
          }),
        },
        createdAt: item.createdAt.toISOString(),
      };
    });
  }

  /**
   * Adds a product / variant to the user's wishlist idempotently.
   */
  async addToWishlist(
    userId: string,
    productId: string,
    variantId?: string | null,
  ): Promise<WishlistItemDto> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product || product.status !== 'ACTIVE') {
      throw new NotFoundException('Product not found or not active');
    }

    const safeVariantId = variantId?.trim() ? variantId.trim() : null;

    let validVariantId: string | null = null;
    if (safeVariantId) {
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: safeVariantId, productId },
      });
      if (variant) {
        validVariantId = variant.id;
      }
    }

    let item = await this.prisma.wishlistItem.findFirst({
      where: {
        userId,
        productId,
        variantId: validVariantId,
      },
      include: {
        product: {
          include: {
            media: {
              where: { isPrimary: true },
              take: 1,
            },
            variants: {
              where: { status: 'ACTIVE' },
              orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
            },
          },
        },
      },
    });

    if (!item) {
      try {
        item = await this.prisma.wishlistItem.create({
          data: {
            userId,
            productId,
            variantId: validVariantId,
          },
          include: {
            product: {
              include: {
                media: {
                  where: { isPrimary: true },
                  take: 1,
                },
                variants: {
                  where: { status: 'ACTIVE' },
                  orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
                },
              },
            },
          },
        });
      } catch {
        item = await this.prisma.wishlistItem.findFirst({
          where: {
            userId,
            productId,
            variantId: validVariantId,
          },
          include: {
            product: {
              include: {
                media: {
                  where: { isPrimary: true },
                  take: 1,
                },
                variants: {
                  where: { status: 'ACTIVE' },
                  orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
                },
              },
            },
          },
        });
      }
    }

    if (!item) {
      throw new NotFoundException('Failed to add product to wishlist');
    }

    const p = item.product;
    const lowestVariant = p.variants[0];
    const primaryMedia = p.media[0];

    return {
      id: item.id,
      userId: item.userId,
      productId: item.productId,
      variantId: item.variantId,
      product: {
        id: p.id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        brand: p.brand,
        primaryImage: primaryMedia
          ? { url: primaryMedia.url, altText: primaryMedia.altText ?? undefined }
          : undefined,
        fromPrice: lowestVariant?.price,
        fromCompareAtPrice: lowestVariant?.compareAtPrice ?? undefined,
        currency: lowestVariant?.currency ?? 'INR',
        variants: p.variants.map((v) => ({
          id: v.id,
          name: v.name,
          sku: v.sku,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          currency: v.currency,
          status: v.status,
        })),
      },
      createdAt: item.createdAt.toISOString(),
    };
  }

  /**
   * Removes an item from the user's wishlist.
   */
  async removeFromWishlist(userId: string, itemId: string): Promise<void> {
    await this.prisma.wishlistItem.deleteMany({
      where: {
        id: itemId,
        userId,
      },
    });
  }

  /**
   * Syncs / merges guest wishlist items upon customer login.
   */
  async syncGuestWishlist(
    userId: string,
    items: Array<{ productId: string; variantId?: string | null }>,
  ): Promise<WishlistItemDto[]> {
    for (const it of items) {
      if (it.productId) {
        await this.addToWishlist(userId, it.productId, it.variantId).catch(() => {});
      }
    }
    return this.getUserWishlist(userId);
  }
}
