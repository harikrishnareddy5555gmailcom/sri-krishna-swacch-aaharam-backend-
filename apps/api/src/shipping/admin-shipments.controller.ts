import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { ShipmentService } from './shipping.service.js';
import { ShippingReconciliationService } from './reconciliation/shipping-reconciliation.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import {
  Permissions,
  type AdminShipmentDto,
  type AdminShipmentListDto,
  type ShipmentDto,
  type UserRole,
} from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';
import { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto.js';
import { CancelShipmentDto } from './dto/cancel-shipment.dto.js';
import { AdminListShipmentsQueryDto, ShippingQueryDto } from './dto/shipping-query.dto.js';
import { ReconcileShipmentDto } from './dto/reconcile-shipment.dto.js';

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
 * Admin Shipments Controller — Phase 13B.4
 *
 * Operational fulfillment management for administrators.
 * Protected by JwtAuthGuard and PermissionsGuard:
 * - GET: SHIPPING.VIEW
 * - POST: SHIPPING.CREATE
 * - PATCH status: SHIPPING.UPDATE
 * - POST cancel: SHIPPING.CANCEL
 * - RECONCILE: SHIPPING.RECONCILE
 *
 * Never leaks raw webhook payloads, internal secrets, or provider credentials.
 */
@Controller('admin/shipments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminShipmentsController {
  constructor(
    private readonly shipmentService: ShipmentService,
    private readonly reconciliationService: ShippingReconciliationService,
  ) {}

  /**
   * GET /api/v1/admin/shipments
   * Lists shipments with bounded pagination, filters, and stable ordering.
   */
  @Get()
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @HttpCode(HttpStatus.OK)
  async listShipments(
    @Req() req: Request,
    @Query() query: AdminListShipmentsQueryDto,
  ): Promise<AdminShipmentListDto> {
    const user = extractUser(req);
    return this.shipmentService.listShipments(user, query);
  }

  /**
   * GET /api/v1/admin/shipments/reconciliation/queue
   * Lists shipments currently flagged as requiring administrative reconciliation.
   * Declared BEFORE parameterized :shipmentId route.
   */
  @Get('reconciliation/queue')
  @RequirePermissions(Permissions.SHIPPING_RECONCILE)
  @HttpCode(HttpStatus.OK)
  async listReconciliationQueue(
    @Req() req: Request,
    @Query() query: ShippingQueryDto,
  ): Promise<{ data: ShipmentDto[]; total: number; page: number; limit: number }> {
    const user = extractUser(req);
    return this.reconciliationService.listReconciliationQueue(user, query);
  }

  /**
   * GET /api/v1/admin/shipments/:shipmentId
   * Retrieves operational shipment details with sanitized events.
   */
  @Get(':shipmentId')
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @HttpCode(HttpStatus.OK)
  async getShipmentById(
    @Req() req: Request,
    @Param('shipmentId') shipmentId: string,
  ): Promise<AdminShipmentDto> {
    const user = extractUser(req);
    return this.shipmentService.getShipmentById(shipmentId, user);
  }

  /**
   * POST /api/v1/admin/shipments
   * Allocates line items and creates a new Shipment record under deterministic row locking.
   */
  @Post()
  @RequirePermissions(Permissions.SHIPPING_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async createShipment(
    @Req() req: Request,
    @Body() input: CreateShipmentDto,
  ): Promise<AdminShipmentDto> {
    const user = extractUser(req);
    return this.shipmentService.createShipment(user, input);
  }

  /**
   * PATCH /api/v1/admin/shipments/:shipmentId/status
   * Executes a validated canonical status transition with inventory and delivery side-effects.
   */
  @Patch(':shipmentId/status')
  @RequirePermissions(Permissions.SHIPPING_UPDATE)
  @HttpCode(HttpStatus.OK)
  async updateShipmentStatus(
    @Req() req: Request,
    @Param('shipmentId') shipmentId: string,
    @Body() input: UpdateShipmentStatusDto,
  ): Promise<AdminShipmentDto> {
    const user = extractUser(req);
    return this.shipmentService.updateShipmentStatus(shipmentId, user, input);
  }

  /**
   * POST /api/v1/admin/shipments/:shipmentId/cancel
   * Cancels an unshipped shipment before physical dispatch.
   */
  @Post(':shipmentId/cancel')
  @RequirePermissions(Permissions.SHIPPING_CANCEL)
  @HttpCode(HttpStatus.OK)
  async cancelShipment(
    @Req() req: Request,
    @Param('shipmentId') shipmentId: string,
    @Body() input: CancelShipmentDto,
  ): Promise<AdminShipmentDto> {
    const user = extractUser(req);
    return this.shipmentService.cancelShipment(shipmentId, user, input);
  }

  /**
   * POST /api/v1/admin/shipments/:shipmentId/reconcile
   * Resolves an operational discrepancy on a flagged shipment under SHIPPING_RECONCILE authority.
   */
  @Post(':shipmentId/reconcile')
  @RequirePermissions(Permissions.SHIPPING_RECONCILE)
  @HttpCode(HttpStatus.OK)
  async reconcileShipment(
    @Req() req: Request,
    @Param('shipmentId') shipmentId: string,
    @Body() input: ReconcileShipmentDto,
  ): Promise<AdminShipmentDto> {
    const user = extractUser(req);
    return this.reconciliationService.reconcileShipment(shipmentId, user, input);
  }
}
