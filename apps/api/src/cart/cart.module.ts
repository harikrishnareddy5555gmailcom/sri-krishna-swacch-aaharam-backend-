import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CartService } from './cart.service.js';
import { CartController } from './cart.controller.js';

/**
 * Cart Module
 *
 * Implements the shopping cart domain:
 * - Anonymous guest carts with cryptographically secure tokens (SHA-256 stored)
 * - Authenticated user carts with strict IDOR protections
 * - Positive integer quantity limits (centralized rule)
 * - Server-authoritative catalog price snapshots in minor units (paise)
 * - Concurrency safety via unique constraints and DB transactions
 * - Safe guest-to-user cart merge with replay protection and availability re-validation
 */
@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
