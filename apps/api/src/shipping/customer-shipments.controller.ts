import {
  Controller,
  Get,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { ShipmentService } from './shipping.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { CustomerShipmentDto, UserRole } from '@vishkaraa/types';
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
 * Customer Shipments Controller — Phase 13B.4
 *
 * Exposes customer-facing read-only shipment tracking and status.
 *
 * Security & IDOR Protections:
 * - All routes require authenticated user (`JwtAuthGuard`).
 * - Ownership is enforced server-side against `order.userId`.
 * - Cross-user access is rejected with HTTP 403 Forbidden.
 * - Manipulated / non-matching shipmentId under another order returns HTTP 404 Not Found.
 * - Customer responses strictly exclude provider secrets, raw webhook payloads, internal
 *   reconciliation notes, internal audit logs, and unvalidated tracking URLs.
 * - Tracking URLs are only returned if matching secure HTTPS provider allowlists.
 */
@Controller('orders/:orderId/shipments')
@UseGuards(JwtAuthGuard)
export class CustomerShipmentsController {
  constructor(private readonly shipmentService: ShipmentService) {}

  /**
   * GET /api/v1/orders/:orderId/shipments
   * Lists all shipments associated with an authenticated customer's order.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async listOrderShipments(
    @Req() req: Request,
    @Param('orderId') orderId: string,
  ): Promise<CustomerShipmentDto[]> {
    const user = extractUser(req);
    return this.shipmentService.getShipmentsForOrder(orderId, user);
  }

  /**
   * GET /api/v1/orders/:orderId/shipments/:shipmentId
   * Retrieves a single shipment for an authenticated customer's order.
   */
  @Get(':shipmentId')
  @HttpCode(HttpStatus.OK)
  async getOrderShipmentById(
    @Req() req: Request,
    @Param('orderId') orderId: string,
    @Param('shipmentId') shipmentId: string,
  ): Promise<CustomerShipmentDto> {
    const user = extractUser(req);
    return this.shipmentService.getShipmentForOrder(orderId, shipmentId, user);
  }
}
