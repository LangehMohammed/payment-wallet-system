import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenDenylistService } from './token-denylist.service';
import { TokenService } from './token.service';
import { TokenCleanupService } from './token-cleanup.service';
import { SessionService } from './session.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: {
          expiresIn: config.get<string>(
            'jwt.accessExpiry',
          ) as unknown as StringValue,
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    AuthRepository,
    JwtStrategy,
    AuditLogger,
    TokenDenylistService,
    TokenCleanupService,
    TokenService,
    SessionService,
  ],
  controllers: [AuthController],
})
export class AuthModule {}
