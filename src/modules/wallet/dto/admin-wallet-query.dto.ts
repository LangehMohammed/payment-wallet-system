import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, Currency } from '@prisma/client';
import { IsBase64, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AdminWalletQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by wallet status',
    enum: AccountStatus,
    example: AccountStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiPropertyOptional({
    description: 'Filter by wallet currency',
    enum: Currency,
    example: Currency.USD,
  })
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;

  @ApiPropertyOptional({
    description:
      'Opaque cursor returned by the previous page response. ' +
      'Omit to fetch the first page.',
    example:
      'eyJjcmVhdGVkQXQiOiIyMDI1LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InV1aWQifQ==',
  })
  @IsOptional()
  @IsBase64()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of results per page — max 100',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
