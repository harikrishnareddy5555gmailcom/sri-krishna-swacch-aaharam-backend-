import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrderService } from './orders.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequireFeatures } from '../auth/decorators/features.decorator.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { PermissionsService } from '../permissions/permissions.service.js';
import { FeatureKey, Permissions, OrderStatus, UserRole } from '@vishkaraa/types';
import type {
  AdminOrderListDto,
  AdminOrderDetailDto,
  OrderDto,
} from '@vishkaraa/types';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
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
 * Admin Orders Controller — Phase 08B
 *
 * All routes require authentication, the ORDERS feature to be active,
 * and granular permissions via PermissionsGuard / PermissionsService.
 */
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, FeaturesGuard, PermissionsGuard)
@RequireFeatures(FeatureKey.ORDERS)
export class AdminOrdersController {
  constructor(
    private readonly orderService: OrderService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * GET /admin/orders
   * Requires ORDERS.VIEW permission.
   */
  @Get()
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @HttpCode(HttpStatus.OK)
  async getAdminOrders(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: OrderStatus,
    @Query('search') search?: string,
    @Query('userId') userId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<AdminOrderListDto> {
    return this.orderService.adminGetOrders({
      page,
      limit,
      status,
      search,
      userId,
      fromDate,
      toDate,
    });
  }

  /**
   * GET /admin/orders/summary
   * Returns order counts grouped by status + today's revenue.
   * Used for Admin Dashboard live stat cards.
   * Requires ORDERS.VIEW permission.
   */
  @Get('summary')
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @HttpCode(HttpStatus.OK)
  async getOrderSummary(): Promise<{
    confirmed: number;
    processing: number;
    shipped: number;
    delivered: number;
    cancelled: number;
    todayRevenuePaise: number;
    totalOrders: number;
  }> {
    return this.orderService.getOrderSummary();
  }

  /**
   * GET /admin/orders/:id
   * Requires ORDERS.VIEW permission.
   * Returns operational payment references and audit trail.
   */
  @Get(':id')
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @HttpCode(HttpStatus.OK)
  async getAdminOrderById(@Param('id') orderId: string): Promise<AdminOrderDetailDto> {
    return this.orderService.adminGetOrderById(orderId);
  }

  /**
   * PATCH /admin/orders/:id/status
   * Requires ORDERS.UPDATE for fulfillment transitions, or ORDERS.CANCEL for cancellation.
   */
  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  async updateOrderStatus(
    @Req() req: Request,
    @Param('id') orderId: string,
    @Body() body: UpdateOrderStatusDto,
  ): Promise<OrderDto> {
    const user = extractUser(req);

    // Permission enforcement according to target status
    const requiredPermission = body.status === OrderStatus.CANCELLED
      ? Permissions.ORDERS_CANCEL
      : Permissions.ORDERS_UPDATE;

    const hasPermission = await this.permissionsService.can(user, requiredPermission);
    if (!hasPermission) {
      throw new ForbiddenException(
        `Forbidden: Missing required permission ${requiredPermission} to set order status to ${body.status}`,
      );
    }

    return this.orderService.updateOrderStatus(orderId, user, body);
  }

  /**
   * POST /admin/orders/:id/cancellation-review
   * Approves or rejects customer's cancellation request.
   */
  @Post(':id/cancellation-review')
  @RequirePermissions(Permissions.ORDERS_UPDATE)
  @HttpCode(HttpStatus.OK)
  async reviewCancellation(
    @Req() req: Request,
    @Param('id') orderId: string,
    @Body() body: { approved: boolean; notes?: string },
  ): Promise<OrderDto> {
    const user = extractUser(req);
    return this.orderService.reviewOrderCancellation(orderId, user, body.approved, body.notes);
  }

  /**
   * PATCH /admin/orders/:id/tracking
   * Saves courier name and tracking number into order metadata.
   * Requires ORDERS.UPDATE permission.
   */
  @Patch(':id/tracking')
  @RequirePermissions(Permissions.ORDERS_UPDATE)
  @HttpCode(HttpStatus.OK)
  async updateTracking(
    @Param('id') orderId: string,
    @Body() body: { courierName?: string; trackingNumber?: string },
  ): Promise<{ success: boolean }> {
    return this.orderService.updateOrderTracking(orderId, body);
  }

  /**
   * PATCH /admin/orders/:id/notes
   * Saves internal admin notes (not shown to customer).
   * Requires ORDERS.UPDATE permission.
   */
  @Patch(':id/notes')
  @RequirePermissions(Permissions.ORDERS_UPDATE)
  @HttpCode(HttpStatus.OK)
  async updateAdminNotes(
    @Param('id') orderId: string,
    @Body() body: { notes: string },
  ): Promise<{ success: boolean }> {
    return this.orderService.updateOrderAdminNotes(orderId, body.notes);
  }
}

