import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  // Security
  app.use(helmet());

  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const allowedOrigins = configService.get<string[]>('app.allowedOrigins');

  // Guard — should never reach here due to Joi validation, but defense-in-depth
  if (
    configService.get('app.env') === 'production' &&
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

  // Global validation — strip unknown fields, auto-transform payloads
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Standardize all responses and errors
  app.useGlobalFilters(new HttpExceptionFilter());

  // Swagger
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
  if (configService.get('app.env') !== 'production') {
    SwaggerModule.setup('api', app, document);
  }

  const port = configService.get<number>('app.port');
  await app.listen(port);
}
bootstrap();
