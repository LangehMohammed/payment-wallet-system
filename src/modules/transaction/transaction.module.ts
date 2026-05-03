import { Module } from '@nestjs/common';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { TransactionRepository } from './transaction.repository';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [TransactionController],
  providers: [
    TransactionService,
    TransactionRepository,
    AuditLogger,
  ],
})
export class TransactionModule {}
