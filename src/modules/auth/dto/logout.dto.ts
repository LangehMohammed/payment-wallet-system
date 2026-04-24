import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class LogoutDto {
  @ApiProperty({
    description: 'The refresh token for the session to terminate',
  })
  @IsString()
  refreshToken: string;
}
