import { Module } from '@nestjs/common';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentProcessorService } from './payment-processor.service';
import { PaymentSettlementService } from './payment-settlement.service';
import { PaymentRepository } from './payment.repository';
import { StripeProvider } from './providers/stripe.provider';
import { PaypalProvider } from './providers/paypal.provider';
import { PaymentProviderRegistry } from './providers/registry/payment-provider.registry';
import { ProviderConfigService } from './providers/config/provider-config.service';
import { PaypalTokenClient } from './providers/paypal-token.client';

@Module({
  imports: [WalletModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PaymentProcessorService,
    PaymentSettlementService,
    PaymentRepository,
    StripeProvider,
    PaypalProvider,
    PaypalTokenClient,
    PaymentProviderRegistry,
    ProviderConfigService,
    AuditLogger,
  ],
  exports: [
    PaymentService,
    PaymentRepository,
    StripeProvider,
    PaypalProvider,
    PaypalTokenClient,
    PaymentProviderRegistry,
  ],
})
export class PaymentModule {}
