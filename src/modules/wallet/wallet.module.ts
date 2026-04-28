import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { WalletRepository } from './wallet.repository';

@Module({
  providers: [WalletService, WalletRepository],
  controllers: [WalletController],
})
export class WalletModule {}
