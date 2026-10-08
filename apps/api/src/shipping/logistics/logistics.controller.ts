import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LogisticsService } from './logistics.service.js';
import {
  EstimateDeliveryDto,
  CreateCourierPartnerDto,
  UpdateCourierPartnerDto,
  CreateRateCardDto,
  CreateBlacklistedPincodeDto,
} from './dto/estimate-delivery.dto.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator.js';
import { Permissions, type ServiceabilityResponse } from '@vishkaraa/types';

@ApiTags('Shipping & Logistics')
@Controller('shipping')
export class LogisticsController {
  constructor(private readonly logisticsService: LogisticsService) {}

  /**
   * Public Multi-Carrier Delivery Estimator
   *
   * Rate-shops active express and heavy cargo carriers, enforces 100% online prepaid policy,
   * falls back to India Post Pincode API on timeout, and caches for 12 hours.
   */
  @Post('estimate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Estimate delivery transit time, carrier, and shipping cost' })
  @ApiResponse({ status: 200, description: 'Computed delivery estimate and serviceability' })
  async estimateDelivery(
    @Body() dto: EstimateDeliveryDto,
  ): Promise<ServiceabilityResponse> {
    return this.logisticsService.estimateDelivery(dto);
  }

  @Get('estimate')
  @ApiOperation({ summary: 'Estimate delivery transit time via query parameters' })
  async estimateDeliveryQuery(
    @Query('pincode') pincode: string,
    @Query('weightGrams') weightGrams?: string,
    @Query('isBulk') isBulk?: string,
  ): Promise<ServiceabilityResponse> {
    return this.logisticsService.estimateDelivery({
      pincode: pincode || '',
      weightGrams: weightGrams ? parseInt(weightGrams, 10) : 500,
      isBulk: isBulk === 'true',
    });
  }

  @Get('pincode/:pincode')
  @ApiOperation({ summary: 'Detect area, district, state, and post offices for 6-digit Indian PIN code' })
  async lookupPincode(@Param('pincode') pincode: string) {
    return this.logisticsService.lookupPincode(pincode);
  }
}

@ApiTags('Admin Logistics Management')
@Controller('admin/logistics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminLogisticsController {
  constructor(private readonly logisticsService: LogisticsService) {}

  // ─── Couriers ─────────────────────────────────────────────────────────────

  @Get('couriers')
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @ApiOperation({ summary: 'Get all courier partners with rate cards' })
  async getAllCouriers() {
    return this.logisticsService.getAllCourierPartners();
  }

  @Post('couriers')
  @RequirePermissions(Permissions.SHIPPING_UPDATE)
  @ApiOperation({ summary: 'Register a new courier partner' })
  async createCourier(@Body() dto: CreateCourierPartnerDto) {
    return this.logisticsService.createCourierPartner(dto);
  }

  @Patch('couriers/:id')
  @RequirePermissions(Permissions.SHIPPING_UPDATE)
  @ApiOperation({ summary: 'Update an existing courier partner' })
  async updateCourier(
    @Param('id') id: string,
    @Body() dto: UpdateCourierPartnerDto,
  ) {
    return this.logisticsService.updateCourierPartner(id, dto);
  }

  // ─── Rate Cards ───────────────────────────────────────────────────────────

  @Get('rate-cards')
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @ApiOperation({ summary: 'Get all configured carrier rate cards' })
  async getAllRateCards() {
    return this.logisticsService.getAllRateCards();
  }

  @Post('rate-cards')
  @RequirePermissions(Permissions.SHIPPING_UPDATE)
  @ApiOperation({ summary: 'Create a new carrier rate card' })
  async createRateCard(@Body() dto: CreateRateCardDto) {
    return this.logisticsService.createRateCard(dto);
  }

  // ─── Blacklisted Pincodes ─────────────────────────────────────────────────

  @Get('blacklisted-pincodes')
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @ApiOperation({ summary: 'Get all blacklisted non-serviceable PIN codes' })
  async getBlacklistedPincodes() {
    return this.logisticsService.getAllBlacklistedPincodes();
  }

  @Post('blacklisted-pincodes')
  @RequirePermissions(Permissions.SHIPPING_UPDATE)
  @ApiOperation({ summary: 'Add a PIN code to the blacklist' })
  async addBlacklistedPincode(@Body() dto: CreateBlacklistedPincodeDto) {
    return this.logisticsService.addBlacklistedPincode(dto);
  }

  @Delete('blacklisted-pincodes/:pincode')
  @RequirePermissions(Permissions.SHIPPING_UPDATE)
  @ApiOperation({ summary: 'Remove a PIN code from the blacklist' })
  async removeBlacklistedPincode(@Param('pincode') pincode: string) {
    return this.logisticsService.removeBlacklistedPincode(pincode);
  }

  // ─── Pincode & Locality Intelligence Inspector ───────────────────────────

  @Get('pincode-lookup/:pincode')
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @ApiOperation({ summary: 'Inspect postal area, courier serviceability, and blacklist status for any PIN code' })
  async inspectPincode(@Param('pincode') pincode: string) {
    return this.logisticsService.lookupPincode(pincode);
  }
}
