import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Build swagger configuration
  const config = new DocumentBuilder()
    .setTitle('Payment Wallet System')
    .setDescription(
      '### Payment Wallet API v1 \n' +
        'This service handles the backend logic for user wallets, transaction processing, and balance reconciliation. \n\n' +
        '**Key Features:** \n' +
        '- Multi-currency support (USD, EUR, BTC) \n' +
        '- Real-time transaction history and webhooks \n' +
        '- Atomic transfer operations \n\n' +
        "*Refer to the 'Models' section below for schema definitions and validation rules.*",
    )
    .setVersion('1.0')
    .addTag('wallet')
    .build();

  // Create the document
  const document = SwaggerModule.createDocument(app, config);

  // Setup the UI path
  SwaggerModule.setup('api', app, document);

  await app.listen(3000);
}
bootstrap();
