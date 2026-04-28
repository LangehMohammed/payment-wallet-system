import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: 'Display name — 2 to 64 characters',
    example: 'Jane Doe',
  })
  @IsOptional()
  @IsString()
  @Length(2, 64)
  name?: string;

  @ApiPropertyOptional({
    description: 'E.164 phone number',
    example: '+12025550187',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message: 'phone must be a valid E.164 number (e.g. +12025550187)',
  })
  phone?: string;
}
