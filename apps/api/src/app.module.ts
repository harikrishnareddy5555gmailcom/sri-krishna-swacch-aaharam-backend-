/**
 * Root Application Module
 *
 * Imports and wires together all top-level feature modules.
 * This is the root of the NestJS dependency injection tree.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './health/health.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { RolesModule } from './roles/roles.module.js';
import { PermissionsModule } from './permissions/permissions.module.js';
import { FeaturesModule } from './features/features.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { ReturnsModule } from './returns/returns.module.js';
import { RefundsModule } from './refunds/refunds.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CartModule } from './cart/cart.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { PaymentModule } from './payment/payment.module.js';
import { CommonModule } from './common/common.module.js';
import { CacheModule } from './common/cache/index.js';
import { ScheduleModule } from '@nestjs/schedule';
import { InventoryModule } from './inventory/inventory.module.js';
import { InvoicesModule } from './invoices/invoices.module.js';
import { ShippingModule } from './shipping/shipping.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { ExpensesModule } from './expenses/expenses.module.js';
import { ContentModule } from './content/content.module.js';
import { WishlistModule } from './wishlist/wishlist.module.js';
import { SystemSettingsModule } from './settings/system-settings.module.js';

@Module({
  imports: [
    // ─── Task Scheduling ─────────────────────────────────────────────────────
    ScheduleModule.forRoot(),
    // ─── Configuration ───────────────────────────────────────────────────────
    // Load environment variables globally. isGlobal=true means ConfigService
    // is available in all modules without importing ConfigModule again.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        '.env.local',
        '.env',
        '../../.env.local',
        '../../.env',
      ],
    }),

    // ─── Rate Limiting ───────────────────────────────────────────────────────
    // Prevents abuse by limiting requests per IP per time window.
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env['RATE_LIMIT_TTL_MS'] ?? '60000', 10),
        limit: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS'] ?? '100', 10),
      },
    ]),

    // ─── Database ────────────────────────────────────────────────────────────
    DatabaseModule,

    // ─── Caching (Phase 19) ───────────────────────────────────────────────────
    CacheModule,

    // ─── Health ──────────────────────────────────────────────────────────────
    HealthModule,

    // ─── Auth ────────────────────────────────────────────────────────────────
    AuthModule,

    // ─── User Management ─────────────────────────────────────────────────────
    UsersModule,
    RolesModule,
    PermissionsModule,

    // ─── Feature Registry ────────────────────────────────────────────────────
    FeaturesModule,

    // ─── Business Modules (Architectural Boundaries) ─────────────────────────
    // These modules define the API boundary and type contracts.
    // Full business logic will be implemented in future phases.
    OrdersModule,
    ReturnsModule,
    RefundsModule,
    AuditModule,

    // ─── Catalog ──────────────────────────────────────────────────────────────
    CatalogModule,

    // ─── Cart ─────────────────────────────────────────────────────────────────
    CartModule,

    // ─── Checkout ─────────────────────────────────────────────────────────────
    CheckoutModule,

    // ─── Payment (Phase 07A) ──────────────────────────────────────────────────
    PaymentModule,

    // ─── Inventory & Stock Integrity (Phase 11) ──────────────────────────────
    InventoryModule,

    // ─── Billing & Invoices (Phase 12) ────────────────────────────────────────
    InvoicesModule,

    // ─── Shipping & Fulfillment (Phase 13) ────────────────────────────────────
    ShippingModule,

    // ─── Notifications Domain Foundation (Phase 14) ───────────────────────────
    NotificationsModule,

    // ─── Finance Foundation & Ledger (Phase 15A) ──────────────────────────────
    FinanceModule,

    // ─── Expenses Domain Foundation (Phase 15C) ───────────────────────────────
    ExpensesModule,

    // ─── Content Management (Phase 20D.3) ─────────────────────────────────────
    ContentModule,

    // ─── Wishlist & Business Settings (Phase 20D.5) ───────────────────────────
    WishlistModule,
    SystemSettingsModule,

    // ─── Common & Ownership Guard ─────────────────────────────────────────────
    CommonModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
