import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrderService } from './orders.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { OrderDto, OrderListDto, UserRole, OrderStatus } from '@vishkaraa/types';
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

/**
 * Orders Controller — Phase 08A
 *
 * All routes require authentication. Orders are always scoped to the
 * authenticated user — no cross-user access is permitted.
 *
 * Routes:
 *   GET /orders            — List authenticated user's orders (paginated)
 *   GET /orders/number/:n  — Retrieve order by orderNumber
 *   GET /orders/:id        — Retrieve order by ID
 */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orderService: OrderService) {}

  /**
   * GET /orders
   * List all orders for the authenticated user, newest first.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async getMyOrders(
    @Req() req: Request,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: OrderStatus,
  ): Promise<OrderListDto> {
    const user = extractUser(req);
    return this.orderService.getUserOrders(user.id, page, limit, status);
  }

  /**
   * GET /orders/number/:orderNumber
   * Retrieve a single order by its human-readable order number.
   * Must be matched before /orders/:id to prevent "number" being parsed as an ID.
   */
  @Get('number/:orderNumber')
  @HttpCode(HttpStatus.OK)
  async getOrderByNumber(
    @Req() req: Request,
    @Param('orderNumber') orderNumber: string,
  ): Promise<OrderDto> {
    const user = extractUser(req);
    return this.orderService.getOrderByNumber(orderNumber, user.id);
  }

  /**
   * GET /orders/:id
   * Retrieve a single order by its UUID.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getOrderById(
    @Req() req: Request,
    @Param('id') orderId: string,
  ): Promise<OrderDto> {
    const user = extractUser(req);
    return this.orderService.getOrderById(orderId, user.id);
  }

  /**
   * POST /orders/:id/cancel-request
   * Customer submits a cancellation request before shipment packaging.
   */
  @Post(':id/cancel-request')
  @HttpCode(HttpStatus.OK)
  async requestCancellation(
    @Req() req: Request,
    @Param('id') orderId: string,
    @Body('reason') reason: string,
  ): Promise<OrderDto> {
    const user = extractUser(req);
    return this.orderService.requestOrderCancellation(orderId, user.id, reason || 'Customer requested cancellation');
  }
}
