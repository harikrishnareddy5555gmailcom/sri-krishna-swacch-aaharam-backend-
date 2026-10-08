import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CartService, type CartActor } from './cart.service.js';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AddToCartRequestDto } from './dto/add-to-cart.dto.js';
import { UpdateCartItemRequestDto } from './dto/update-cart-item.dto.js';
import { MergeCartRequestDto } from './dto/merge-cart.dto.js';
import type { CartSummaryDto, MergeCartResultDto } from '@vishkaraa/types';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role?: string;
    email?: string;
  };
}

/**
 * Extracts actor context (authenticated user or guest token) from request.
 */
function extractActor(req: Request): CartActor {
  const user = (req as AuthenticatedRequest).user;
  const guestToken = (req.headers['x-guest-cart-token'] as string | undefined)?.trim();

  return {
    userId: user?.id,
    userRole: user?.role,
    userEmail: user?.email,
    guestToken: guestToken || undefined,
  };
}

@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  /**
   * GET /cart
   *
   * Retrieve active cart for authenticated user or guest.
   * If an unauthenticated visitor has no cart token, a new guest cart is initialized
   * and the cryptographically secure token is returned in the 'x-guest-cart-token' header
   * and the response payload.
   */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  async getCart(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartSummaryDto> {
    const actor = extractActor(req);
    const { cart, rawGuestToken } = await this.cartService.getOrCreateCart(actor);

    if (rawGuestToken) {
      res.setHeader('x-guest-cart-token', rawGuestToken);
      res.setHeader('Access-Control-Expose-Headers', 'x-guest-cart-token');
    }

    return cart;
  }

  /**
   * POST /cart/items
   *
   * Add a product variant to the cart.
   * Authoritative price snapshot is read server-side from catalog.
   */
  @Post('items')
  @UseGuards(OptionalJwtAuthGuard)
  async addItem(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: AddToCartRequestDto,
  ): Promise<CartSummaryDto> {
    const actor = extractActor(req);
    const { cart, rawGuestToken } = await this.cartService.addItem(actor, dto);

    if (rawGuestToken) {
      res.setHeader('x-guest-cart-token', rawGuestToken);
      res.setHeader('Access-Control-Expose-Headers', 'x-guest-cart-token');
    }

    return cart;
  }

  /**
   * PATCH /cart/items/:itemId
   *
   * Update the quantity of an existing cart item.
   */
  @Patch('items/:itemId')
  @UseGuards(OptionalJwtAuthGuard)
  async updateItemQuantity(
    @Req() req: Request,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemRequestDto,
  ): Promise<CartSummaryDto> {
    const actor = extractActor(req);
    return this.cartService.updateItemQuantity(actor, itemId, dto.quantity);
  }

  /**
   * DELETE /cart/items/:itemId
   *
   * Remove an item from the cart.
   */
  @Delete('items/:itemId')
  @UseGuards(OptionalJwtAuthGuard)
  async removeItem(
    @Req() req: Request,
    @Param('itemId') itemId: string,
  ): Promise<CartSummaryDto> {
    const actor = extractActor(req);
    return this.cartService.removeItem(actor, itemId);
  }

  /**
   * DELETE /cart
   *
   * Clear all items from the active cart.
   */
  @Delete()
  @UseGuards(OptionalJwtAuthGuard)
  async clearCart(@Req() req: Request): Promise<CartSummaryDto> {
    const actor = extractActor(req);
    return this.cartService.clearCart(actor);
  }

  /**
   * POST /cart/merge
   *
   * Merge an anonymous guest cart into the authenticated user's cart upon login/register.
   * Requires authenticated user. Replays are rejected with 409 Conflict.
   */
  @Post('merge')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async mergeCart(
    @Req() req: Request,
    @Body() dto: MergeCartRequestDto,
  ): Promise<MergeCartResultDto> {
    const user = (req as AuthenticatedRequest).user;
    return this.cartService.mergeGuestCart(user!.id, dto.guestToken);
  }
}
