import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CategoriesService } from './categories.service.js';
import {
  PublicCategoriesController,
  AdminCategoriesController,
} from './categories.controller.js';
import { ProductsService } from './products.service.js';
import {
  PublicProductsController,
  AdminProductsController,
  AdminVariantsController,
  AdminMediaController,
} from './products.controller.js';

import { StorageModule } from '../common/storage/storage.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

/**
 * Catalog Module
 *
 * Provides the product catalog domain:
 *   - Category hierarchy (unlimited depth, soft-delete)
 *   - Products (catalog identity, no inventory)
 *   - ProductVariants (SKUs, pricing in paise)
 *   - ProductMedia (provider-independent media references)
 *
 * Public endpoints: no authentication required.
 * Admin endpoints: JWT + PermissionsGuard with granular permissions.
 */
@Module({
  imports: [DatabaseModule, AuditModule, PermissionsModule, AuthModule, StorageModule, InventoryModule],
  controllers: [
    // Public
    PublicCategoriesController,
    PublicProductsController,
    // Admin
    AdminCategoriesController,
    AdminProductsController,
    AdminVariantsController,
    AdminMediaController,
  ],
  providers: [CategoriesService, ProductsService],
  exports: [CategoriesService, ProductsService],
})
export class CatalogModule {}
