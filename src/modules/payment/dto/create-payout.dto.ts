import { ApiProperty } from '@nestjs/swagger';
import { Currency } from '@prisma/client';
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
  IsEmail,
} from 'class-validator';

const SupportedProviders = {
  STRIPE: 'STRIPE',
  PAYPAL: 'PAYPAL',
} as const;

type SupportedProvider =
  (typeof SupportedProviders)[keyof typeof SupportedProviders];

/**
 * Request DTO for POST /payments/payouts/create
 *
 * Creates a payout (withdrawal) to an external account.
 * Creates Transaction (INITIATED) + OutboxEvent for async processing.
 */
export class CreatePayoutDto {
  @ApiProperty({
    description: 'Payment provider to use',
    enum: [SupportedProviders.STRIPE, SupportedProviders.PAYPAL],
    example: SupportedProviders.STRIPE,
  })
  @IsEnum([SupportedProviders.STRIPE, SupportedProviders.PAYPAL], {
    message:
      'provider must be STRIPE or PAYPAL (INTERNAL is not supported for payouts)',
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
    description: 'Client-generated idempotency key (UUID v4)',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID(4)
  idempotencyKey: string;

  @ApiProperty({
    description: 'Optional payout description',
    example: 'Withdrawal to bank account',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  description?: string;
}
