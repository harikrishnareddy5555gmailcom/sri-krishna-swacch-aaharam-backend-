import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { WishlistService } from './wishlist.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { WishlistItemDto } from '@vishkaraa/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

@Controller('wishlist')
@UseGuards(JwtAuthGuard)
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getMyWishlist(@Req() req: AuthenticatedRequest): Promise<WishlistItemDto[]> {
    return this.wishlistService.getUserWishlist(req.user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async addToWishlist(
    @Req() req: AuthenticatedRequest,
    @Body() body: { productId: string; variantId?: string },
  ): Promise<WishlistItemDto> {
    if (!body.productId?.trim()) {
      throw new BadRequestException('productId is required');
    }
    return this.wishlistService.addToWishlist(req.user.id, body.productId.trim(), body.variantId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async removeFromWishlist(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ success: boolean }> {
    await this.wishlistService.removeFromWishlist(req.user.id, id);
    return { success: true };
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncGuestWishlist(
    @Req() req: AuthenticatedRequest,
    @Body() body: { items: Array<{ productId: string; variantId?: string }> },
  ): Promise<WishlistItemDto[]> {
    const items = Array.isArray(body?.items) ? body.items : [];
    return this.wishlistService.syncGuestWishlist(req.user.id, items);
  }
}
