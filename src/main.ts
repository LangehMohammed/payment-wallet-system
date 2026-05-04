import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as basicAuth from 'express-basic-auth';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const env = configService.get<string>('app.env');

  // ── Security middleware ────────────────────────────────────────────────────

  app.use(helmet());
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // ── CORS ───────────────────────────────────────────────────────────────────

  const allowedOrigins = configService.get<string[]>('app.allowedOrigins');

  if (
    env === 'production' &&
    (!allowedOrigins || allowedOrigins.length === 0)
  ) {
    throw new Error('ALLOWED_ORIGINS must be configured in production');
  }

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    credentials: true,
  });

  // ── Global pipes & filters ─────────────────────────────────────────────────

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  // ── Swagger ────────────────────────────────────────────────────────────────

  if (env !== 'production') {
    const swaggerUser = configService.get<string>('swagger.user');
    const swaggerPassword = configService.get<string>('swagger.password');

    if (!swaggerUser || !swaggerPassword) {
      throw new Error(
        'SWAGGER_USER and SWAGGER_PASSWORD must be set in non-production environments. ' +
          'The Swagger UI exposes the full API surface and must not be publicly accessible.',
      );
    }

    // Protect /api and /api-json before registering the Swagger module.
    // express-basic-auth runs as Express middleware, evaluated before NestJS
    // route handlers — the challenge fires even if the NestJS guard is bypassed.
    app.use(
      ['/api', '/api-json'],
      basicAuth({
        users: { [swaggerUser]: swaggerPassword },
        challenge: true, // sends WWW-Authenticate header → browser shows login dialog
        realm: 'Swagger UI',
      }),
    );

    const config = new DocumentBuilder()
      .setTitle('Payment Wallet System')
      .setDescription(
        '### Payment Wallet API v1\n' +
          'Ledger-based wallet system with double-entry bookkeeping.\n\n' +
          '**Key Features:**\n' +
          '- Ledger as source of truth (double-entry)\n' +
          '- Atomic deposit, withdrawal, and P2P transfer\n' +
          '- Idempotency keys on all mutations\n' +
          '- Outbox pattern for async provider calls\n\n' +
          '_All endpoints require a Bearer token unless marked public._',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('Auth', 'Registration, login, token refresh')
      .addTag('Users', 'User profile management')
      .addTag('Wallets', 'Wallet balances and ledger statement')
      .addTag('Transactions', 'Deposit, withdrawal, transfer')
      .addTag('Admin', 'Admin-only operations')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
  }

  // ── Listen ─────────────────────────────────────────────────────────────────

  const port = configService.get<number>('app.port');
  await app.listen(port);
}
bootstrap();
