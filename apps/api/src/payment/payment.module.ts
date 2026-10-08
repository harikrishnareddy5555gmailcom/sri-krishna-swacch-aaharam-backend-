import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { CommonModule } from '../common/common.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { PaymentController } from './payment.controller.js';
import { PaymentService } from './payment.service.js';
import { WebhookController } from './webhook.controller.js';
import { WebhookService } from './webhook.service.js';
import { PaymentExpirationService } from './payment-expiration.service.js';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface.js';
import { MockPaymentProvider } from './providers/mock-payment.provider.js';
import { RazorpayPaymentProvider } from './providers/razorpay/razorpay.provider.js';
import { resolvePaymentProviderConfig } from './payment-provider.config.js';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    FeaturesModule,
    PermissionsModule,
    CheckoutModule,
    CommonModule,
    OrdersModule,  // Provides OrderService for webhook CAPTURED finalization
    FinanceModule, // Provides FinanceService for captured payment ledger posting
    // ScheduleModule enables @Cron() decorators (used by PaymentExpirationService)
    ScheduleModule.forRoot(),
  ],
  controllers: [PaymentController, WebhookController],
  providers: [
    PaymentService,
    WebhookService,
    PaymentExpirationService,
    MockPaymentProvider,
    // Active provider resolution: explicit configuration with production guard
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (mock: MockPaymentProvider) => {
        const provider = resolvePaymentProviderConfig(process.env);
        if (provider === 'RAZORPAY') {
          return new RazorpayPaymentProvider();
        }
        return mock;
      },
      inject: [MockPaymentProvider],
    },
  ],
  exports: [PaymentService, WebhookService, MockPaymentProvider, PAYMENT_PROVIDER],
})
export class PaymentModule {}
