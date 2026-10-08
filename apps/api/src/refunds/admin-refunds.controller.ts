import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RefundService } from './refund.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequireFeatures } from '../auth/decorators/features.decorator.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { FeatureKey, Permissions, UserRole } from '@vishkaraa/types';
import { RefundSource } from '@prisma/client';
import type { MinimalUser } from '../permissions/permissions.service.js';
import type {
  CreateRefundDto,
  ApproveRefundDto,
  RejectRefundDto,
  ReconcileRefundAttemptDto,
  RefundDto,
  OrderRefundSummaryDto,
} from './refund.service.js';
import {
  IsInt,
  IsPositive,
  MinLength,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  Min,
} from 'class-validator';

// =============================================================================
// REQUEST DTOs (with validation)
// =============================================================================

class CreateRefundRequestDto implements CreateRefundDto {
  @IsInt()
  @IsPositive()
  amount!: number;

  @IsString()
  @MinLength(5)
  reason!: string;

  @IsEnum(RefundSource)
  source!: RefundSource;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}

class ApproveRefundRequestDto implements ApproveRefundDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  approvedAmount?: number;
}

class RejectRefundRequestDto implements RejectRefundDto {
  @IsString()
  @MinLength(5)
  rejectionReason!: string;
}

class ReconcileRefundRequestDto implements ReconcileRefundAttemptDto {
  @IsIn(['PROCESSED', 'FAILED'])
  resolution!: 'PROCESSED' | 'FAILED';

  @IsOptional()
  @IsString()
  notes?: string;
}

// =============================================================================
// AUTHENTICATED REQUEST TYPE
// =============================================================================

interface AuthenticatedRequest extends Request {
  user: { id: string; role: string; email: string };
}

function extractUser(req: Request): MinimalUser {
  const user = (req as AuthenticatedRequest).user;
  return { id: user.id, role: user.role as UserRole, email: user.email };
}

// =============================================================================
// ADMIN REFUNDS CONTROLLER
// =============================================================================

/**
 * Admin Refunds Controller — Phase 09B
 *
 * All routes require:
 *   1. JWT authentication (JwtAuthGuard)
 *   2. REFUNDS feature to be active (FeaturesGuard)
 *   3. Granular permission (PermissionsGuard + @RequirePermissions)
 *
 * Customers CANNOT access any of these endpoints.
 * Customer-facing refund status is surfaced through the Orders API.
 */
@Controller('admin/orders/:orderId/refunds')
@UseGuards(JwtAuthGuard, FeaturesGuard, PermissionsGuard)
@RequireFeatures(FeatureKey.REFUNDS)
export class AdminRefundsController {
  constructor(private readonly refundService: RefundService) {}

  /**
   * GET /admin/orders/:orderId/refunds
   * Returns all refunds for an order plus financial balance summary.
   * Requires REFUNDS.VIEW permission.
   */
  @Get()
  @RequirePermissions(Permissions.REFUNDS_VIEW)
  @HttpCode(HttpStatus.OK)
  async getRefundsForOrder(
    @Param('orderId') orderId: string,
  ): Promise<OrderRefundSummaryDto> {
    return this.refundService.getRefundsForOrder(orderId);
  }

  /**
   * POST /admin/orders/:orderId/refunds
   * Creates a new refund request.
   * Auto-approves if amount <= threshold; otherwise creates in REQUESTED state.
   * Requires REFUNDS.CREATE permission.
   */
  @Post()
  @RequirePermissions(Permissions.REFUNDS_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async createRefund(
    @Req() req: Request,
    @Param('orderId') orderId: string,
    @Body() body: CreateRefundRequestDto,
  ): Promise<RefundDto> {
    const actor = extractUser(req);
    return this.refundService.createRefund(orderId, actor, body);
  }
}

/**
 * Admin Refund Operations Controller — Phase 09B
 *
 * Operations on individual refund records (approve, reject, cancel, reconcile).
 * Mounted at /admin/refunds/:refundId/* — not nested under orders.
 */
@Controller('admin/refunds')
@UseGuards(JwtAuthGuard, FeaturesGuard, PermissionsGuard)
@RequireFeatures(FeatureKey.REFUNDS)
export class AdminRefundOperationsController {
  constructor(private readonly refundService: RefundService) {}

  /**
   * POST /admin/refunds/:refundId/approve
   * Approves a REQUESTED refund and dispatches to gateway.
   * Dual-control: approver != requester.
   * Requires REFUNDS.APPROVE permission.
   */
  @Post(':refundId/approve')
  @RequirePermissions(Permissions.REFUNDS_APPROVE)
  @HttpCode(HttpStatus.OK)
  async approveRefund(
    @Req() req: Request,
    @Param('refundId') refundId: string,
    @Body() body: ApproveRefundRequestDto,
  ): Promise<RefundDto> {
    const actor = extractUser(req);
    return this.refundService.approveRefund(refundId, actor, body);
  }

  /**
   * POST /admin/refunds/:refundId/reject
   * Rejects a REQUESTED refund with mandatory reason.
   * Requires REFUNDS.APPROVE permission.
   */
  @Post(':refundId/reject')
  @RequirePermissions(Permissions.REFUNDS_APPROVE)
  @HttpCode(HttpStatus.OK)
  async rejectRefund(
    @Req() req: Request,
    @Param('refundId') refundId: string,
    @Body() body: RejectRefundRequestDto,
  ): Promise<RefundDto> {
    const actor = extractUser(req);
    return this.refundService.rejectRefund(refundId, actor, body);
  }

  /**
   * POST /admin/refunds/:refundId/cancel
   * Cancels a REQUESTED refund before gateway dispatch.
   * Requires REFUNDS.MANAGE permission.
   */
  @Post(':refundId/cancel')
  @RequirePermissions(Permissions.REFUNDS_MANAGE)
  @HttpCode(HttpStatus.OK)
  async cancelRefund(
    @Req() req: Request,
    @Param('refundId') refundId: string,
  ): Promise<RefundDto> {
    const actor = extractUser(req);
    return this.refundService.cancelRefund(refundId, actor);
  }

  /**
   * POST /admin/refunds/:refundId/attempts/:attemptId/reconcile
   * Manually resolves a RECONCILIATION_REQUIRED attempt.
   * Requires REFUNDS.RECONCILE permission.
   */
  @Post(':refundId/attempts/:attemptId/reconcile')
  @RequirePermissions(Permissions.REFUNDS_RECONCILE)
  @HttpCode(HttpStatus.OK)
  async reconcileAttempt(
    @Req() req: Request,
    @Param('refundId') refundId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: ReconcileRefundRequestDto,
  ): Promise<RefundDto> {
    const actor = extractUser(req);
    return this.refundService.reconcileRefundAttempt(refundId, attemptId, actor, body);
  }
}
