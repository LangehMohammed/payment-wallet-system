import { ApiProperty } from '@nestjs/swagger';
import { Provider, Currency } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsPositive,
  Min,
  IsOptional,
  IsString,
} from 'class-validator';

const SupportedProviders = {
  STRIPE: 'STRIPE',
  PAYPAL: 'PAYPAL',
} as const;

type SupportedProvider =
  (typeof SupportedProviders)[keyof typeof SupportedProviders];
/**
 * Request DTO for POST /payments/deposits/intents
 *
 * Creates a deposit intent with the selected provider.
 * Returns client_secret (Stripe) or client_token (Braintree) for frontend payment collection.
 */
export class CreateDepositIntentDto {
  @ApiProperty({
    description: 'Payment provider to use',
    enum: [SupportedProviders.STRIPE, SupportedProviders.PAYPAL],
    example: SupportedProviders.STRIPE,
  })
  @IsEnum(SupportedProviders, {
    message:
      'provider must be STRIPE or PAYPAL (INTERNAL is not supported for deposits)',
  })
  provider: SupportedProvider;

  @ApiProperty({
    description: 'Amount in major currency units (e.g., 100.50 USD)',
    example: 100.5,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  @Min(0.0001)
  amount: number;

  @ApiProperty({
    description: 'Currency code',
    enum: Currency,
    example: Currency.USD,
  })
  @IsEnum(Currency)
  currency: Currency;

  @ApiProperty({
    description:
      'Optional Braintree customer ID for loading vaulted payment methods',
    example: 'braintree_customer_123',
    required: false,
  })
  @IsOptional()
  @IsString()
  braintreeCustomerId?: string;
}
