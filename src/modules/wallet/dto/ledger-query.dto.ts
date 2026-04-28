import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBase64, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class LedgerQueryDto {
  @ApiPropertyOptional({
    description:
      'Opaque cursor returned by the previous page response. ' +
      'Omit to fetch the first page.',
    example: 'eyJjcmVhdGVkQXQiOiIyMDI1LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InV1aWQifQ==',
  })
  @IsOptional()
  @IsBase64()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of entries per page — max 100',
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
