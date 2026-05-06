import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Provider, TransactionStatus, TransactionType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/prisma/prisma.service';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { PaymentRepository } from './payment.repository';
import { ProviderResult } from './dto/provider-result.dto';

interface TransactionContext {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: Prisma.Decimal;
  currency: string;
  provider: Provider | null;
  senderWalletId: string | null;
  receiverWalletId: string | null;
}

/**
 * Handles the atomic settlement and failure paths for provider-processed transactions.
 *
 * Each public method wraps all mutations in a single `prisma.$transaction` block:
 *   settle: balance move + Transaction status → SETTLED + PaymentLog + outbox delivery mark
 *   fail:   balance reversal + Transaction status → FAILED + PaymentLog + outbox delivery mark
 *
 * This service is the only place that drives balance mutations triggered by
 * async provider callbacks. Synchronous (internal transfer) settlement lives
 * in TransactionService and never passes through here.
 */
@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger(PaymentSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletRepository: WalletRepository,
    private readonly paymentRepository: PaymentRepository,
    private readonly audit: AuditLogger,
  ) {}

  // ── Settle ─────────────────────────────────────────────────────────────────

  /**
   * Atomically settles a provider-confirmed transaction.
   *
   * DEPOSIT settlement:
   *   pendingBalance  -= amount
   *   availableBalance += amount
   *   Transaction → SETTLED + settledAt + providerRef
   *   LedgerEntry (CREDIT, balanceAfter = new availableBalance)
   *   PaymentLog (SETTLED)
   *   OutboxEvent → deliveredAt = now
   *
   * WITHDRAWAL settlement:
   *   lockedBalance -= amount
   *   Transaction → SETTLED + settledAt + providerRef
   *   LedgerEntry (DEBIT, balanceAfter = new lockedBalance)
   *   PaymentLog (SETTLED)
   *   OutboxEvent → deliveredAt = now
   */
  async settle(
    txCtx: TransactionContext,
    outboxEventId: string,
    result: ProviderResult,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (txCtx.type === TransactionType.DEPOSIT) {
        await this.settleDeposit(txCtx, outboxEventId, result, tx);
      } else if (txCtx.type === TransactionType.WITHDRAWAL) {
        await this.settleWithdrawal(txCtx, outboxEventId, result, tx);
      } else {
        // Should never reach here — TRANSFER events are excluded from outbox polling.
        throw new UnprocessableEntityException(
          `settle() called on unsupported transaction type: ${txCtx.type}`,
        );
      }
    });

    void this.audit.log('DEPOSIT_SETTLED', {
      meta: {
        transactionId: txCtx.id,
        type: txCtx.type,
        providerRef: result.providerRef,
      },
    });
  }

  // ── Fail ───────────────────────────────────────────────────────────────────

  /**
   * Atomically reverses a failed provider transaction.
   *
   * DEPOSIT failure:
   *   pendingBalance -= amount  (return to zero — funds never left us)
   *   Transaction → FAILED
   *   PaymentLog (FAILED)
   *   OutboxEvent → deliveredAt = now
   *
   * WITHDRAWAL failure:
   *   lockedBalance    -= amount
   *   availableBalance += amount  (restore funds to spendable)
   *   Transaction → FAILED
   *   PaymentLog (FAILED)
   *   OutboxEvent → deliveredAt = now
   */
  async fail(
    txCtx: TransactionContext,
    outboxEventId: string,
    result: ProviderResult,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (txCtx.type === TransactionType.DEPOSIT) {
        await this.failDeposit(txCtx, outboxEventId, result, tx);
      } else if (txCtx.type === TransactionType.WITHDRAWAL) {
        await this.failWithdrawal(txCtx, outboxEventId, result, tx);
      } else {
        throw new UnprocessableEntityException(
          `fail() called on unsupported transaction type: ${txCtx.type}`,
        );
      }
    });

    void this.audit.warn('DEPOSIT_FAILED', {
      meta: {
        transactionId: txCtx.id,
        type: txCtx.type,
        errorMessage: result.errorMessage,
      },
    });
  }

  // ── Private — settle paths ─────────────────────────────────────────────────

  private async settleDeposit(
    txCtx: TransactionContext,
    outboxEventId: string,
    result: ProviderResult,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // Move pending → available
    const availableBalanceAfter = await this.walletRepository.settlePending(
      txCtx.receiverWalletId!,
      txCtx.amount,
      tx,
    );

    // Stamp providerRef and mark SETTLED
    if (result.providerRef) {
      await this.paymentRepository.setProviderRef(txCtx.id, result.providerRef, tx);
    }

    await tx.transaction.update({
      where: { id: txCtx.id },
      data: {
        status: TransactionStatus.SETTLED,
        settledAt: new Date(),
      },
    });

    // CREDIT ledger entry (settled, reflects new availableBalance)
    await tx.ledgerEntry.create({
      data: {
        walletId: txCtx.receiverWalletId!,
        transactionId: txCtx.id,
        direction: 'CREDIT',
        amount: txCtx.amount,
        currency: txCtx.currency as any,
        balanceAfter: availableBalanceAfter,
      },
    });

    await this.paymentRepository.createPaymentLog(
      {
        transactionId: txCtx.id,
        provider: txCtx.provider!,
        providerRef: result.providerRef,
        payload: result.rawResponse as Prisma.InputJsonValue,
        status: TransactionStatus.SETTLED,
      },
      tx,
    );

    await this.paymentRepository.markDelivered(outboxEventId, tx);

    this.logger.log('Deposit settled', {
      transactionId: txCtx.id,
      providerRef: result.providerRef,
    });
  }

  private async settleWithdrawal(
    txCtx: TransactionContext,
    outboxEventId: string,
    result: ProviderResult,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // Debit locked balance — funds have left the system
    const lockedBalanceAfter = await this.walletRepository.settleWithdrawal(
      txCtx.senderWalletId!,
      txCtx.amount,
      tx,
    );

    if (result.providerRef) {
      await this.paymentRepository.setProviderRef(txCtx.id, result.providerRef, tx);
    }

    await tx.transaction.update({
      where: { id: txCtx.id },
      data: {
        status: TransactionStatus.SETTLED,
        settledAt: new Date(),
      },
    });

    // DEBIT ledger entry (settled, reflects new lockedBalance)
    await tx.ledgerEntry.create({
      data: {
        walletId: txCtx.senderWalletId!,
        transactionId: txCtx.id,
        direction: 'DEBIT',
        amount: txCtx.amount,
        currency: txCtx.currency as any,
        balanceAfter: lockedBalanceAfter,
      },
    });

    await this.paymentRepository.createPaymentLog(
      {
        transactionId: txCtx.id,
        provider: txCtx.provider!,
        providerRef: result.providerRef,
        payload: result.rawResponse as Prisma.InputJsonValue,
        status: TransactionStatus.SETTLED,
      },
      tx,
    );

    await this.paymentRepository.markDelivered(outboxEventId, tx);

    this.logger.log('Withdrawal settled', {
      transactionId: txCtx.id,
      providerRef: result.providerRef,
    });
  }

  // ── Private — fail paths ───────────────────────────────────────────────────

  private async failDeposit(
    txCtx: TransactionContext,
    outboxEventId: string,
    result: ProviderResult,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // Reverse the pending credit — funds never arrived
    await tx.wallet.update({
      where: { id: txCtx.receiverWalletId! },
      data: { pendingBalance: { decrement: txCtx.amount } },
    });

    await tx.transaction.update({
      where: { id: txCtx.id },
      data: { status: TransactionStatus.FAILED },
    });

    await this.paymentRepository.createPaymentLog(
      {
        transactionId: txCtx.id,
        provider: txCtx.provider!,
        providerRef: result.providerRef,
        payload: result.rawResponse as Prisma.InputJsonValue,
        status: TransactionStatus.FAILED,
      },
      tx,
    );

    await this.paymentRepository.markDelivered(outboxEventId, tx);

    this.logger.warn('Deposit failed — pending balance reversed', {
      transactionId: txCtx.id,
      errorMessage: result.errorMessage,
    });
  }

  private async failWithdrawal(
    txCtx: TransactionContext,
    outboxEventId: string,
    result: ProviderResult,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // Restore locked funds back to available — withdrawal did not go through
    await tx.wallet.update({
      where: { id: txCtx.senderWalletId! },
      data: {
        lockedBalance: { decrement: txCtx.amount },
        availableBalance: { increment: txCtx.amount },
      },
    });

    await tx.transaction.update({
      where: { id: txCtx.id },
      data: { status: TransactionStatus.FAILED },
    });

    await this.paymentRepository.createPaymentLog(
      {
        transactionId: txCtx.id,
        provider: txCtx.provider!,
        providerRef: result.providerRef,
        payload: result.rawResponse as Prisma.InputJsonValue,
        status: TransactionStatus.FAILED,
      },
      tx,
    );

    await this.paymentRepository.markDelivered(outboxEventId, tx);

    this.logger.warn('Withdrawal failed — locked balance restored to available', {
      transactionId: txCtx.id,
      errorMessage: result.errorMessage,
    });
  }
}
