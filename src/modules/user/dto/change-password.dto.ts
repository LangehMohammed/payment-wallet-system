import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({
    description: "The user's current password",
    example: 'CurrentP@ss1',
  })
  @IsString()
  @Length(8, 72)
  currentPassword: string;

  @ApiProperty({
    description:
      'New password — 8–72 chars, must contain uppercase, lowercase, digit, and special character. ' +
      'Max 72 chars (argon2 effective limit).',
    example: 'NewP@ssw0rd!',
  })
  @IsString()
  @Length(8, 72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d])/, {
    message:
      'newPassword must contain at least one uppercase letter, one lowercase letter, ' +
      'one digit, and one special character',
  })
  newPassword: string;
}
