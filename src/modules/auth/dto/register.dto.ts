import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsPhoneNumber,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'John Doe', description: 'Full name of the user' })
  @IsString()
  @MinLength(2, { message: 'name must be at least 2 characters' })
  @MaxLength(100, { message: 'name must be at most 100 characters' })
  name: string;

  @ApiProperty({
    example: 'john@example.com',
    description: 'Unique email address',
  })
  @Transform(({ value }: { value: string }) => value?.toLowerCase().trim())
  @IsEmail()
  email: string;

  @ApiProperty({
    example: '+12345678901',
    description:
      'Unique phone number in E.164 format — must include country code (e.g. +12345678901)',
  })
  @IsPhoneNumber(null, {
    message:
      'phone must be a valid E.164 number including country code (e.g. +12345678901)',
  })
  phone: string;

  @ApiProperty({
    example: 'P@ssw0rd!',
    description:
      'Min 8 characters. Must contain at least one uppercase letter, one lowercase letter, one digit, and one special character.',
  })
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(72, {
    message: 'password must be at most 72 characters',
  })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/, {
    message:
      'password must contain at least one uppercase letter, one lowercase letter, one number, and one special character',
  })
  password: string;
}
