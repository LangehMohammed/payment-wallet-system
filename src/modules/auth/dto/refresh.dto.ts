import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RefreshDto {
  @ApiProperty({ description: 'The refresh token issued at login' })
  @IsString()
  refreshToken: string;
}
