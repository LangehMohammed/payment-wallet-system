import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { CurrentUser } from '@app/common/decorators/current-user.decorator';
import { Roles } from '@app/common/decorators/roles.decorator';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { UsersService } from './users.service';
import {
  AdminUpdateUserDto,
  ChangePasswordDto,
  UpdateProfileDto,
  UserQueryDto,
} from './dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ── User-facing ────────────────────────────────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'Get own profile with wallet summary' })
  @ApiResponse({
    status: 200,
    description: 'Returns the authenticated user profile',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getMe(@CurrentUser() user: JwtPayload) {
    return this.usersService.getMe(user.sub);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update own profile — name and/or phone' })
  @ApiResponse({ status: 200, description: 'Returns the updated profile' })
  @ApiResponse({ status: 400, description: 'No updatable fields provided' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 409, description: 'Phone number already in use' })
  updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.sub, dto);
  }

  @Patch('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  // 5 per minute — makes brute-forcing current password impractical
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary:
      'Change own password — revokes all sessions and denylists current token',
  })
  @ApiResponse({
    status: 204,
    description: 'Password changed, all sessions revoked',
  })
  @ApiResponse({ status: 400, description: 'New password same as current' })
  @ApiResponse({ status: 401, description: 'Current password incorrect' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.usersService.changePassword(user.sub, user.jti, dto);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  // 3 per hour — account closure is irreversible, rate-limit aggressively
  @Throttle({ global: { ttl: 60 * 60_000, limit: 3 } })
  @ApiOperation({
    summary: 'Close own account — irreversible, requires zero wallet balance',
  })
  @ApiResponse({ status: 204, description: 'Account closed, session revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 409,
    description: 'Wallet balance must be zero before closing',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  closeAccount(@CurrentUser() user: JwtPayload) {
    return this.usersService.closeAccount(user.sub, user.jti);
  }

  // ── Admin-facing ───────────────────────────────────────────────────────────

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: '[Admin] List all users — paginated with optional filters',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated user list with totals',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  listUsers(@Query() query: UserQueryDto) {
    return this.usersService.listUsers(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '[Admin] Get any user profile by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({
    status: 200,
    description: 'Returns the user profile with wallet summary',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiResponse({ status: 404, description: 'User not found' })
  getUserById(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getUserById(id);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: "[Admin] Update a user's status or role — cannot target self",
  })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'Returns the updated user profile' })
  @ApiResponse({ status: 400, description: 'No updatable fields provided' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — admin only, or self-targeting',
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({
    status: 409,
    description: 'Wallet balance must be zero before closing',
  })
  updateUserStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.usersService.updateUserStatus(user.sub, id, dto);
  }
}
