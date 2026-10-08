import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ReturnService } from './return.service.js';
import type {
  CreateReturnDto,
  CreateReturnItemDto,
  ApproveReturnDto,
  RejectReturnDto,
  ReceiveReturnDto,
  InspectReturnDto,
  InspectReturnItemDto,
  AdminListReturnsQuery,
  ReturnDto,
} from './return.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsService } from '../permissions/permissions.service.js';
import { Permissions, type UserRole } from '@vishkaraa/types';
import {
  ReturnStatus,
  ReturnReason,
  ReturnItemCondition,
  ReturnItemDisposition,
} from '@prisma/client';
import type { MinimalUser } from '../permissions/permissions.service.js';
import {
  IsInt,
  IsPositive,
  IsString,
  IsUUID,
  IsEnum,
  IsOptional,
  IsArray,
  ValidateNested,
  MinLength,
  Min,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

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

// =============================================================================
// REQUEST DTOs
// =============================================================================

export class CreateReturnItemRequestDto implements CreateReturnItemDto {
  @IsUUID()
  orderItemId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;

  @IsEnum(ReturnReason)
  reason!: ReturnReason;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateReturnRequestDto implements CreateReturnDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateReturnItemRequestDto)
  items!: CreateReturnItemRequestDto[];

  @IsOptional()
  @IsString()
  customerNotes?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidenceKeys?: string[];

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class ApproveReturnRequestDto implements ApproveReturnDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RejectReturnRequestDto implements RejectReturnDto {
  @IsString()
  @MinLength(5)
  rejectionReason!: string;
}

export class ReceiveReturnRequestDto implements ReceiveReturnDto {
  @IsObject()
  receivedQuantities!: Record<string, number>;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class InspectReturnItemRequestDto implements InspectReturnItemDto {
  @IsUUID()
  orderItemId!: string;

  @IsInt()
  @Min(0)
  acceptedQuantity!: number;

  @IsInt()
  @Min(0)
  rejectedQuantity!: number;

  @IsEnum(ReturnItemCondition)
  condition!: ReturnItemCondition;

  @IsEnum(ReturnItemDisposition)
  disposition!: ReturnItemDisposition;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class InspectReturnRequestDto implements InspectReturnDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InspectReturnItemRequestDto)
  items!: InspectReturnItemRequestDto[];

  @IsOptional()
  @IsString()
  inspectionNotes?: string;
}

export class AdminCancelReturnRequestDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AdminListReturnsQueryDto implements AdminListReturnsQuery {
  @IsOptional()
  @IsEnum(ReturnStatus)
  status?: ReturnStatus;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  rmaNumber?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

// =============================================================================
// CUSTOMER CONTROLLER — /orders/:orderId/returns  &  /returns/:id
// =============================================================================

@Controller()
@UseGuards(JwtAuthGuard)
export class ReturnsController {
  constructor(private readonly returnService: ReturnService) {}

  @Post('orders/:orderId/returns')
  async createReturn(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateReturnRequestDto,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    return this.returnService.createReturn(orderId, actor, dto);
  }

  @Get('orders/:orderId/returns')
  async listOrderReturns(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() req: Request,
  ): Promise<ReturnDto[]> {
    const actor = extractUser(req);
    return this.returnService.getReturnsForOrder(orderId, actor);
  }

  @Get('returns/:id')
  async getReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    return this.returnService.getReturn(id, actor, false);
  }

  @Post('returns/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    return this.returnService.cancelReturn(id, actor, false);
  }
}

// =============================================================================
// ADMIN CONTROLLER — /admin/returns/*
// =============================================================================

@Controller('admin/returns')
@UseGuards(JwtAuthGuard)
export class AdminReturnsController {
  constructor(
    private readonly returnService: ReturnService,
    private readonly permissionsService: PermissionsService,
  ) {}

  @Get()
  async listReturns(
    @Query() query: AdminListReturnsQueryDto,
    @Req() req: Request,
  ): Promise<ReturnDto[]> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_VIEW);
    if (!can) throw new ForbiddenException('RETURNS.VIEW permission required.');
    return this.returnService.adminListReturns(query);
  }

  @Get(':id')
  async getReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_VIEW);
    if (!can) throw new ForbiddenException('RETURNS.VIEW permission required.');
    return this.returnService.getReturn(id, actor, true);
  }

  @Post()
  async adminCreateReturn(
    @Query('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateReturnRequestDto,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_CREATE);
    if (!can) throw new ForbiddenException('RETURNS.CREATE permission required.');
    return this.returnService.adminCreateReturn(orderId, actor, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approveReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveReturnRequestDto,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_APPROVE);
    if (!can) throw new ForbiddenException('RETURNS.APPROVE permission required.');
    return this.returnService.approveReturn(id, actor, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectReturnRequestDto,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_REJECT);
    if (!can) throw new ForbiddenException('RETURNS.REJECT permission required.');
    return this.returnService.rejectReturn(id, actor, dto);
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  async receiveReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveReturnRequestDto,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_INSPECT);
    if (!can) throw new ForbiddenException('RETURNS.INSPECT permission required.');
    return this.returnService.receiveReturn(id, actor, dto);
  }

  @Post(':id/inspect')
  @HttpCode(HttpStatus.OK)
  async inspectReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InspectReturnRequestDto,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_INSPECT);
    if (!can) throw new ForbiddenException('RETURNS.INSPECT permission required.');
    return this.returnService.inspectReturn(id, actor, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async adminCancelReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdminCancelReturnRequestDto,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_MANAGE);
    if (!can) throw new ForbiddenException('RETURNS.MANAGE permission required.');
    return this.returnService.cancelReturn(id, actor, true, body.reason);
  }

  @Post(':id/reconcile-refund')
  @HttpCode(HttpStatus.OK)
  async reconcileReturnRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<ReturnDto> {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.RETURNS_MANAGE);
    if (!can) throw new ForbiddenException('RETURNS.MANAGE permission required.');
    return this.returnService.reconcileReturnRefund(id, actor);
  }
}