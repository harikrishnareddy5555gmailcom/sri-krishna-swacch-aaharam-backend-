import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { ShipmentService } from './shipping.service.js';
import { MockShippingProvider } from './providers/mock/mock-shipping.provider.js';
import { ShippingProviderRegistry } from './providers/shipping-provider.registry.js';
import { ShippingWebhookService } from './webhook/shipping-webhook.service.js';
import { ShippingWebhookController } from './webhook/shipping-webhook.controller.js';
import { CustomerShipmentsController } from './customer-shipments.controller.js';
import { AdminShipmentsController } from './admin-shipments.controller.js';
import { ShippingReconciliationService } from './reconciliation/shipping-reconciliation.service.js';
import { LogisticsService } from './logistics/logistics.service.js';
import { LogisticsRoutingEngine } from './logistics/logistics-routing.engine.js';
import {
  LogisticsController,
  AdminLogisticsController,
} from './logistics/logistics.controller.js';

/**
 * ShippingModule — Phase 13 & 20D.9
 *
 * Core domain, provider abstraction, webhook ingress, and
 * Enterprise Multi-Courier Delivery Estimator & Smart Logistics Routing Engine.
 */
@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    AuditModule,
    InventoryModule,
  ],
  controllers: [
    CustomerShipmentsController,
    AdminShipmentsController,
    ShippingWebhookController,
    LogisticsController,
    AdminLogisticsController,
  ],
  providers: [
    ShipmentService,
    {
      provide: MockShippingProvider,
      useFactory: () => new MockShippingProvider(),
    },
    ShippingProviderRegistry,
    ShippingWebhookService,
    ShippingReconciliationService,
    LogisticsRoutingEngine,
    LogisticsService,
  ],
  exports: [
    ShipmentService,
    ShippingWebhookService,
    ShippingReconciliationService,
    ShippingProviderRegistry,
    MockShippingProvider,
    LogisticsRoutingEngine,
    LogisticsService,
  ],
})
export class ShippingModule {}
