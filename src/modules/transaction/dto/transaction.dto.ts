import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Currency } from '@prisma/client';

// ─── Shared ───────────────────────────────────────────────────────────────────

export class MoneyDto {
  @ApiProperty({
    example: 100.5,
    description: 'Amount in major currency units. Max 4 decimal places.',
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  @Min(0.0001)
  amount: number;

  @ApiProperty({ enum: Currency, example: Currency.USD })
  @IsEnum(Currency)
  currency: Currency;
}

// ─── Deposit ──────────────────────────────────────────────────────────────────

export class DepositDto extends MoneyDto {
  /**
   * Client-generated idempotency key.
   * Re-submitting the same key within the TTL returns the original result.
   */
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'Client-generated UUID v4. Safe to retry with same key.',
  })
  @IsUUID(4)
  idempotencyKey: string;

  @ApiPropertyOptional({ example: 'Top-up from bank account' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  description?: string;
}

// ─── Withdrawal ───────────────────────────────────────────────────────────────

export class WithdrawalDto extends MoneyDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'Client-generated UUID v4. Safe to retry with same key.',
  })
  @IsUUID(4)
  idempotencyKey: string;

  @ApiPropertyOptional({ example: 'Withdrawal to bank account' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  description?: string;
}

// ─── Transfer ─────────────────────────────────────────────────────────────────

export class TransferDto extends MoneyDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'Client-generated UUID v4. Safe to retry with same key.',
  })
  @IsUUID(4)
  idempotencyKey: string;

  @ApiProperty({
    example: 'usr_abc123',
    description: 'Recipient user ID.',
  })
  @IsUUID(4)
  recipientUserId: string;

  @ApiPropertyOptional({ example: 'Splitting dinner' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  description?: string;
}

// ─── Query ────────────────────────────────────────────────────────────────────

export class TransactionQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10))
  page: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => Math.min(parseInt(value, 10), 100))
  limit: number = 20;
}
