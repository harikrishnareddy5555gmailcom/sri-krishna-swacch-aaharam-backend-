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
import { InventoryService } from './inventory.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionsService } from '../permissions/permissions.service.js';
import { Permissions, type UserRole } from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';
import {
  AdminListInventoryQueryDto,
  AdminListMovementsQueryDto,
} from './dto/inventory-query.dto.js';
import {
  AdjustStockDto,
  StockIncreaseBodyDto,
  StockDecreaseBodyDto,
  SetStockBodyDto,
} from './dto/adjust-stock.dto.js';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

function extractUser(req: Request): MinimalUser {
  const user = (req as AuthenticatedRequest).user;
  if (!user || !user.id) {
    throw new ForbiddenException('User authentication context is missing.');
  }
  return {
    id: user.id,
    role: user.role as UserRole,
    email: user.email,
  };
}

@Controller('admin/inventory')
@UseGuards(JwtAuthGuard)
export class AdminInventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly permissionsService: PermissionsService,
  ) {}

  @Get()
  async listInventory(
    @Query() query: AdminListInventoryQueryDto,
    @Req() req: Request,
  ) {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.INVENTORY_VIEW);
    if (!can) {
      throw new ForbiddenException('INVENTORY.VIEW permission required.');
    }
    return this.inventoryService.adminListInventory(query);
  }

  @Get('movements')
  async listMovements(
    @Query() query: AdminListMovementsQueryDto,
    @Req() req: Request,
  ) {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.INVENTORY_VIEW);
    if (!can) {
      throw new ForbiddenException('INVENTORY.VIEW permission required.');
    }
    return this.inventoryService.adminListMovements(query);
  }

  @Get('variants/:variantId')
  async getVariantInventory(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Req() req: Request,
  ) {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.INVENTORY_VIEW);
    if (!can) {
      throw new ForbiddenException('INVENTORY.VIEW permission required.');
    }
    return this.inventoryService.getBalance(variantId);
  }

  @Get(':variantId')
  async getVariantInventoryDirect(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Req() req: Request,
  ) {
    return this.getVariantInventory(variantId, req);
  }

  @Post([':variantId/increase', 'variants/:variantId/increase'])
  @HttpCode(HttpStatus.OK)
  async increaseStock(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: StockIncreaseBodyDto,
    @Req() req: Request,
  ) {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.INVENTORY_MANAGE);
    if (!can) {
      throw new ForbiddenException('INVENTORY.MANAGE permission required.');
    }
    return this.inventoryService.increaseStock({
      variantId,
      quantity: dto.quantity,
      reason: dto.reason,
      notes: dto.notes,
      idempotencyKey: dto.idempotencyKey,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
    });
  }

  @Post([':variantId/decrease', 'variants/:variantId/decrease'])
  @HttpCode(HttpStatus.OK)
  async decreaseStock(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: StockDecreaseBodyDto,
    @Req() req: Request,
  ) {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.INVENTORY_MANAGE);
    if (!can) {
      throw new ForbiddenException('INVENTORY.MANAGE permission required.');
    }
    return this.inventoryService.decreaseStock({
      variantId,
      quantity: dto.quantity,
      reason: dto.reason,
      notes: dto.notes,
      idempotencyKey: dto.idempotencyKey,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
    });
  }

  @Post([':variantId/adjust', 'variants/:variantId/adjust'])
  @HttpCode(HttpStatus.OK)
  async adjustStock(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: AdjustStockDto,
    @Req() req: Request,
  ) {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.INVENTORY_MANAGE);
    if (!can) {
      throw new ForbiddenException('INVENTORY.MANAGE permission required.');
    }
    return this.inventoryService.adjustStock({
      variantId,
      delta: dto.delta,
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
    });
  }

  @Post([':variantId/set-stock', 'variants/:variantId/set-stock'])
  @HttpCode(HttpStatus.OK)
  async setStock(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: SetStockBodyDto,
    @Req() req: Request,
  ) {
    const actor = extractUser(req);
    const can = await this.permissionsService.can(actor, Permissions.INVENTORY_MANAGE);
    if (!can) {
      throw new ForbiddenException('INVENTORY.MANAGE permission required.');
    }
    return this.inventoryService.setStock({
      variantId,
      quantity: dto.quantity,
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
    });
  }
}
