import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AppController } from './app.controller';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import configuration from './config/configuration';
import { configValidationSchema } from './config';
import {
  RequestContextInterceptor,
  ResponseInterceptor,
} from './common/interceptors';
import { RedisModule } from './modules/redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { CryptoModule } from './modules/crypto/crypto.module';
import { UsersModule } from './modules/user/users.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: configValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    ScheduleModule.forRoot(),
    // Global rate limiter — auth routes override with tighter limits
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 60_000, // 1 minute window
        limit: 120, // 120 req/min for general routes
      },
    ]),
    PrismaModule,
    AuthModule,
    RedisModule,
    HealthModule,
    CryptoModule,
    UsersModule,
    WalletModule,
    // Feature modules are registered here as they are implemented
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule {}
