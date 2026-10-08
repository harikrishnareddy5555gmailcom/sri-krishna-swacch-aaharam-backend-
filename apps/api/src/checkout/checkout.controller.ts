import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { CheckoutService } from './checkout.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { InitializeCheckoutDto, ShippingAddressDto } from './dto/initialize-checkout.dto.js';
import type {
  CheckoutSessionDto,
  RevalidateCheckoutResultDto,
  UserRole,
} from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

function extractUser(req: Request): MinimalUser {
  const user = (req as AuthenticatedRequest).user;
  return {
    id: user.id,
    role: user.role as UserRole,
    email: user.email,
  };
}

@Controller('checkout')
@UseGuards(JwtAuthGuard)
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  /**
   * POST /checkout
   *
   * Initializes or idempotently retrieves an authoritative checkout session
   * for the authenticated user's active cart.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async initializeCheckout(
    @Req() req: Request,
    @Body() dto?: InitializeCheckoutDto,
  ): Promise<CheckoutSessionDto> {
    const user = extractUser(req);
    return this.checkoutService.initializeCheckout(
      user,
      dto?.idempotencyKey,
      dto?.shippingAddress,
      dto?.buyNowItem,
    );
  }

  /**
   * GET /checkout/:id
   *
   * Retrieves an authoritative checkout session by ID.
   * Strictly enforces customer ownership and session expiration.
   */
  @Get(':id')
  async getCheckoutSession(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<CheckoutSessionDto> {
    const user = extractUser(req);
    return this.checkoutService.getCheckoutSession(id, user);
  }

  /**
   * PUT /checkout/:id/shipping-address
   *
   * Updates the shipping address snapshot on an active checkout session.
   * Strictly blocked if an active (CREATED, PENDING) or CAPTURED PaymentAttempt exists.
   */
  @Put(':id/shipping-address')
  @HttpCode(HttpStatus.OK)
  async updateShippingAddress(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ShippingAddressDto,
  ): Promise<CheckoutSessionDto> {
    const user = extractUser(req);
    return this.checkoutService.updateShippingAddress(id, user, dto);
  }

  /**
   * POST /checkout/:id/revalidate
   *
   * Revalidates an existing checkout session against the live catalog
   * and current active cart state before proceeding to future payment.
   */
  @Post(':id/revalidate')
  @HttpCode(HttpStatus.OK)
  async revalidateCheckout(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<RevalidateCheckoutResultDto> {
    const user = extractUser(req);
    return this.checkoutService.revalidateCheckout(id, user);
  }

  /**
   * POST /checkout/:id/cancel
   *
   * Cancels an active checkout session.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelCheckout(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<CheckoutSessionDto> {
    const user = extractUser(req);
    return this.checkoutService.cancelCheckout(id, user);
  }
}
