import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { FeaturesGuard } from '../auth/guards/features.guard.js';
import { PermissionsGuard } from '../auth/guards/permissions.guard.js';
import { RequireFeatures } from '../auth/decorators/features.decorator.js';
import { RequirePermissions } from '../auth/decorators/permissions.decorator.js';
import { FeatureKey, Permissions, type UserRole } from '@vishkaraa/types';
import type { MinimalUser } from '../permissions/permissions.service.js';
import { PaymentService } from './payment.service.js';
import { CreatePaymentAttemptDto } from './dto/create-payment-attempt.dto.js';
import { VerifyPaymentDto } from './dto/verify-payment.dto.js';

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

@Controller('payments')
@UseGuards(JwtAuthGuard, FeaturesGuard, PermissionsGuard)
@RequireFeatures(FeatureKey.PAYMENTS)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permissions.PAYMENTS_CREATE)
  async createPaymentAttempt(
    @Req() req: Request,
    @Body() dto: CreatePaymentAttemptDto,
  ) {
    const user = extractUser(req);
    const attempt = await this.paymentService.createPaymentAttempt(dto, user);
    return {
      success: true,
      data: attempt,
    };
  }

  @Get(':id')
  @RequirePermissions(Permissions.PAYMENTS_VIEW)
  async getPaymentAttempt(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const user = extractUser(req);
    const attempt = await this.paymentService.getPaymentAttempt(id, user);
    return {
      success: true,
      data: attempt,
    };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permissions.PAYMENTS_CREATE)
  async verifyPayment(
    @Req() req: Request,
    @Body() dto: VerifyPaymentDto,
  ) {
    const user = extractUser(req);
    const result = await this.paymentService.verifyAndFinalizePayment(dto, user);
    return {
      success: true,
      data: result,
    };
  }
}
