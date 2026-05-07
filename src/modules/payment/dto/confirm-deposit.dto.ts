import { ApiProperty } from '@nestjs/swagger';
import { Currency, Provider } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsPositive,
  Min,
  IsString,
  IsUUID,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  ValidateIf,
} from 'class-validator';

const SupportedProviders = {
  STRIPE: 'STRIPE',
  PAYPAL: 'PAYPAL',
} as const;

type SupportedProvider =
  (typeof SupportedProviders)[keyof typeof SupportedProviders];

/**
 * Request DTO for POST /payments/deposits/confirm
 *
 * Confirms a deposit after the frontend has collected payment details.
 * Creates a Transaction (INITIATED) and OutboxEvent for async settlement.
 */
export class ConfirmDepositDto {
  @ApiProperty({
    description: 'Payment provider used',
    enum: [SupportedProviders.STRIPE, SupportedProviders.PAYPAL],
    example: SupportedProviders.STRIPE,
  })
  @IsEnum(SupportedProviders)
  provider: SupportedProvider;

  @ApiProperty({
    description: 'Amount in major currency units (must match intent amount)',
    example: 100.5,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  @Min(0.0001)
  amount: number;

  @ApiProperty({
    description: 'Currency code (must match intent currency)',
    enum: Currency,
    example: Currency.USD,
  })
  @IsEnum(Currency)
  currency: Currency;

  @ApiProperty({
    description: 'Client-generated idempotency key (UUID v4)',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID(4)
  idempotencyKey: string;

  @ApiProperty({
    description: 'Optional transaction description',
    example: 'Wallet top-up via bank account',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  description?: string;

  // ── Stripe-specific fields ────────────────────────────────────────────────

  @ApiProperty({
    description: 'Stripe PaymentIntent ID (required if provider is STRIPE)',
    example: 'pi_1234567890abcdef',
    required: false,
  })
  @ValidateIf((o) => o.provider === SupportedProviders.STRIPE)
  @IsString()
  @IsNotEmpty()
  paymentIntentId?: string;

  // ── Braintree-specific fields ─────────────────────────────────────────────

  @ApiProperty({
    description:
      'Braintree payment method nonce (required if provider is PAYPAL)',
    example: 'nonce_from_drop_in_ui',
    required: false,
  })
  @ValidateIf((o) => o.provider === SupportedProviders.PAYPAL)
  @IsString()
  @IsNotEmpty()
  nonce?: string;

  @ApiProperty({
    description: 'Braintree customer ID for vaulting (optional, PAYPAL only)',
    example: 'braintree_customer_123',
    required: false,
  })
  @IsOptional()
  @IsString()
  braintreeCustomerId?: string;
}
