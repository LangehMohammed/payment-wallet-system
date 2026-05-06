import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ProviderConfigService {
  constructor(private readonly configService: ConfigService) {}

  getStripeConfig() {
    return {
      secretKey: this.configService.get<string>('stripe.secretKey'),
      webhookSecret: this.configService.get<string>('stripe.webhookSecret'),
    };
  }

  getPaypalConfig() {
    return {
      clientId: this.configService.get<string>('paypal.clientId'),
      clientSecret: this.configService.get<string>('paypal.clientSecret'),
      webhookId: this.configService.get<string>('paypal.webhookId'),
    };
  }
}
