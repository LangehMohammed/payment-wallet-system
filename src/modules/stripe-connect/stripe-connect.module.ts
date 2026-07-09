import { Module } from '@nestjs/common';
import { StripeConnectController } from './stripe-connect.controller';
import { StripeConnectService } from './stripe-connect.service';
import { StripeConnectRepository } from './stripe-connect.repository';
import { StripeConnectClient } from './stripe-connect.client';
import { StripeConnectWebhookController } from './stripe-connect-webhook.controller';
import { StripeConnectWebhookService } from './stripe-connect-webhook.service';

@Module({
  controllers: [StripeConnectController, StripeConnectWebhookController],
  providers: [
    StripeConnectService,
    StripeConnectWebhookService,
    StripeConnectRepository,
    StripeConnectClient,
  ],
  exports: [StripeConnectRepository, StripeConnectClient],
})
export class StripeConnectModule {}
