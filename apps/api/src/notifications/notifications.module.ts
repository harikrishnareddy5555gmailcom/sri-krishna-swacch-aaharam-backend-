/**
 * Notifications Module — Phase 14B Foundation
 *
 * Provides database access and domain services for the Notifications subsystem.
 */

import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NotificationRepository } from './notification.repository.js';
import { NotificationService } from './notification.service.js';
import { NotificationsController } from './notifications.controller.js';
import { MockEmailProvider } from './providers/mock/mock-email.provider.js';
import { MockSmsProvider } from './providers/mock/mock-sms.provider.js';
import { NotificationProviderRegistry } from './providers/notification-provider.registry.js';
import { NotificationTemplateRegistry } from './templates/notification-template.registry.js';

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [
    NotificationRepository,
    NotificationService,
    MockEmailProvider,
    MockSmsProvider,
    NotificationProviderRegistry,
    NotificationTemplateRegistry,
  ],
  exports: [
    NotificationRepository,
    NotificationService,
    MockEmailProvider,
    MockSmsProvider,
    NotificationProviderRegistry,
    NotificationTemplateRegistry,
  ],
})
export class NotificationsModule {}
