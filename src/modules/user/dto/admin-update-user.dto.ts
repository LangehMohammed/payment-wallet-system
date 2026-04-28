import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, Role } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class AdminUpdateUserDto {
  @ApiProperty({
    description: 'Account status to set',
    enum: AccountStatus,
    example: AccountStatus.FROZEN,
    required: false,
  })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiProperty({
    description: 'Role to assign',
    enum: Role,
    example: Role.ADMIN,
    required: false,
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
