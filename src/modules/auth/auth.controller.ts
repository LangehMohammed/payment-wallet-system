import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { CurrentUser, Public } from '@app/common/decorators';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  // 10 registrations per hour per IP — prevents account-farming
  @Throttle({ global: { ttl: 60 * 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Register a new user — creates wallet automatically',
  })
  @ApiResponse({
    status: 201,
    description: 'Returns access and refresh tokens',
  })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  register(
    @Body() dto: RegisterDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.register(dto, userAgent);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // 5 attempts per minute per IP — brute-force protection
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'Login — creates a new session, returns token pair',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns access and refresh tokens',
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  login(@Body() dto: LoginDto, @Headers('user-agent') userAgent?: string) {
    return this.authService.login(dto, userAgent);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // 20 refreshes per minute per IP — generous for mobile apps, still protective
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: 'Rotate refresh token — old token is revoked, new pair issued',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns new access and refresh tokens',
  })
  @ApiResponse({
    status: 401,
    description: 'Token invalid, expired, or already rotated',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  refresh(@Body() dto: RefreshDto, @Headers('user-agent') userAgent?: string) {
    return this.authService.refresh(dto.refreshToken, userAgent);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  // 10 logouts per minute — prevents token hash probing
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Logout — revokes this session only' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  logout(
    @Body() dto: LogoutDto,
    @CurrentUser() user: JwtPayload,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.logout(
      dto.refreshToken,
      user.sub,
      user.jti,
      userAgent,
    );
  }

  @Post('logout/all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  // 5 per minute — this is a nuclear operation, should rarely be called
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'Logout all — revokes every active session for this user',
  })
  @ApiResponse({ status: 204, description: 'All sessions revoked' })
  logoutAll(@CurrentUser() user: JwtPayload) {
    return this.authService.logoutAll(user.sub);
  }
}
