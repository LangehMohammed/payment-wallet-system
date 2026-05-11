import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ProviderConfigService {
  constructor(private readonly configService: ConfigService) {}

  get StripeConfig() {
    return {
      secretKey: this.configService.get<string>('stripe.secretKey'),
      webhookSecret: this.configService.get<string>('stripe.webhookSecret'),
    };
  }

  get BraintreeConfig() {
    return {
      merchantId: this.configService.get<string>('braintree.merchantId'),
      publicKey: this.configService.get<string>('braintree.publicKey'),
      privateKey: this.configService.get<string>('braintree.privateKey'),
      environment: this.configService.get<string>('braintree.environment'),
    };
  }
}
