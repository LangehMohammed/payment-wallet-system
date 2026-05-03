import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Provider } from '@prisma/client';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { PrismaService } from '@app/prisma/prisma.service';
import { TransactionRepository } from './transaction.repository';
import { DepositDto, TransferDto, TransactionQueryDto, WithdrawalDto } from './dto/transaction.dto';
import { WalletRepository } from '../wallet/wallet.repository';

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface TransactionResult {
  id: string;
  idempotencyKey: string;
  type: string;
  status: string;
  amount: Prisma.Decimal;
  currency: string;
  description?: string;
  createdAt: Date;
  settledAt?: Date;
}

export interface PaginatedTransactions {
  items: TransactionResult[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactionRepository: TransactionRepository,
    private readonly walletRepository: WalletRepository,
    private readonly audit: AuditLogger,
  ) {}

  // ── Deposit ────────────────────────────────────────────────────────────────

  /**
   * Deposit flow (two-phase):
   *   Phase 1 — INITIATION (this method):
   *     Lock wallet → validate → credit pendingBalance → write Transaction +
   *     LedgerEntry (pending) + OutboxEvent → return INITIATED transaction.
   *
   *   Phase 2 — SETTLEMENT (triggered by provider webhook / outbox worker):
   *     Move pendingBalance → availableBalance → update Transaction → SETTLED.
   *
   * Idempotency: duplicate idempotencyKey returns the original transaction.
   */
  async deposit(
    userId: string,
    dto: DepositDto,
  ): Promise<TransactionResult> {
    // ── Idempotency check (outside tx — cheap read first) ──────────────────
    const existing = await this.transactionRepository.findByIdempotencyKey(
      dto.idempotencyKey,
    );
    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: { idempotencyKey: dto.idempotencyKey, transactionId: existing.id },
      });
      return this.toResult(existing);
    }

    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock wallet row — prevents concurrent deposit/withdrawal races
      const wallet = await this.walletRepository.findByUserId(userId);
      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);

      // Credit pendingBalance — funds not yet spendable
      const pendingBalanceAfter = await this.walletRepository.creditPending(
        locked.id,
        amount,
        tx,
      );

      const transaction = await this.transactionRepository.initiateDeposit(
        {
          idempotencyKey: dto.idempotencyKey,
          type: 'DEPOSIT' as any,
          status: 'INITIATED' as any,
          amount,
          currency: dto.currency,
          description: dto.description,
          receiverWalletId: locked.id,
          provider: Provider.INTERNAL, // Override with STRIPE/PAYPAL when integrated
        },
        pendingBalanceAfter,
        {
          walletId: locked.id,
          userId,
          amount: amount.toString(),
          currency: dto.currency,
        } satisfies Prisma.InputJsonValue,
        tx,
      );

      return transaction;
    });

    this.audit.log('DEPOSIT_INITIATED', {
      userId,
      meta: {
        transactionId: result.id,
        amount: dto.amount,
        currency: dto.currency,
      },
    });

    return this.toResult(result);
  }

  // ── Withdrawal ─────────────────────────────────────────────────────────────

  /**
   * Withdrawal flow (two-phase):
   *   Phase 1 — INITIATION (this method):
   *     Lock wallet → validate sufficient balance → debit availableBalance,
   *     credit lockedBalance → write Transaction + LedgerEntry + OutboxEvent.
   *
   *   Phase 2 — SETTLEMENT (outbox worker after provider confirms):
   *     Debit lockedBalance → Transaction → SETTLED.
   *
   *   Funds are unavailable (locked) while withdrawal is in-flight.
   */
  async withdraw(
    userId: string,
    dto: WithdrawalDto,
  ): Promise<TransactionResult> {
    const existing = await this.transactionRepository.findByIdempotencyKey(
      dto.idempotencyKey,
    );
    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: { idempotencyKey: dto.idempotencyKey, transactionId: existing.id },
      });
      return this.toResult(existing);
    }

    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const wallet = await this.walletRepository.findByUserId(userId);
      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);
      this.assertSufficientBalance(locked.availableBalance, amount, userId);

      const { lockedBalance } = await this.walletRepository.debitAvailableAndLock(
        locked.id,
        amount,
        tx,
      );

      const transaction = await this.transactionRepository.initiateWithdrawal(
        {
          idempotencyKey: dto.idempotencyKey,
          type: 'WITHDRAWAL' as any,
          status: 'INITIATED' as any,
          amount,
          currency: dto.currency,
          description: dto.description,
          senderWalletId: locked.id,
          provider: Provider.INTERNAL,
        },
        lockedBalance,
        {
          walletId: locked.id,
          userId,
          amount: amount.toString(),
          currency: dto.currency,
        } satisfies Prisma.InputJsonValue,
        tx,
      );

      return transaction;
    });

    this.audit.log('WITHDRAWAL_INITIATED', {
      userId,
      meta: {
        transactionId: result.id,
        amount: dto.amount,
        currency: dto.currency,
      },
    });

    return this.toResult(result);
  }

  // ── Transfer ───────────────────────────────────────────────────────────────

  /**
   * P2P transfer (single-phase — internal, settles instantly):
   *   Lock sender + receiver wallets (consistent ordering by wallet ID to
   *   prevent deadlocks) → validate → debit sender → credit receiver →
   *   write Transaction (SETTLED) + 2× LedgerEntry + OutboxEvent.
   *
   *   Lock ordering: always lock lower UUID first to eliminate deadlock cycles.
   */
  async transfer(
    userId: string,
    dto: TransferDto,
  ): Promise<TransactionResult> {
    if (userId === dto.recipientUserId) {
      throw new BadRequestException('Cannot transfer to yourself.');
    }

    const existing = await this.transactionRepository.findByIdempotencyKey(
      dto.idempotencyKey,
    );
    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: { idempotencyKey: dto.idempotencyKey, transactionId: existing.id },
      });
      return this.toResult(existing);
    }

    const amount = new Prisma.Decimal(dto.amount);

    // Resolve wallet IDs before entering the transaction
    const [senderWallet, receiverWallet] = await Promise.all([
      this.walletRepository.findByUserId(userId),
      this.walletRepository.findByUserId(dto.recipientUserId),
    ]);

    const result = await this.prisma.$transaction(async (tx) => {
      // Consistent lock ordering — prevents AB/BA deadlock across concurrent transfers
      const [firstId, secondId] =
        senderWallet.id < receiverWallet.id
          ? [senderWallet.id, receiverWallet.id]
          : [receiverWallet.id, senderWallet.id];

      const firstLocked = await this.walletRepository.lockWallet(firstId, tx);
      const secondLocked = await this.walletRepository.lockWallet(secondId, tx);

      // Re-map after locking (lock order ≠ sender/receiver order)
      const lockedSender =
        firstLocked.id === senderWallet.id ? firstLocked : secondLocked;
      const lockedReceiver =
        firstLocked.id === receiverWallet.id ? firstLocked : secondLocked;

      this.walletRepository.assertActive(lockedSender);
      this.walletRepository.assertActive(lockedReceiver);
      this.walletRepository.assertCurrencyMatch(lockedSender, dto.currency);
      this.walletRepository.assertCurrencyMatch(lockedReceiver, dto.currency);
      this.assertSufficientBalance(lockedSender.availableBalance, amount, userId);

      const senderBalanceAfter = await this.walletRepository.debitAvailable(
        lockedSender.id,
        amount,
        tx,
      );

      const receiverBalanceAfter = await this.walletRepository.creditAvailable(
        lockedReceiver.id,
        amount,
        tx,
      );

      const transaction = await this.transactionRepository.executeTransfer(
        {
          idempotencyKey: dto.idempotencyKey,
          type: 'TRANSFER' as any,
          status: 'SETTLED' as any,
          amount,
          currency: dto.currency,
          description: dto.description,
          senderWalletId: lockedSender.id,
          receiverWalletId: lockedReceiver.id,
        },
        senderBalanceAfter,
        receiverBalanceAfter,
        {
          senderWalletId: lockedSender.id,
          senderUserId: userId,
          receiverWalletId: lockedReceiver.id,
          receiverUserId: dto.recipientUserId,
          amount: amount.toString(),
          currency: dto.currency,
        } satisfies Prisma.InputJsonValue,
        tx,
      );

      return transaction;
    });

    this.audit.log('TRANSFER_SETTLED', {
      userId,
      meta: {
        transactionId: result.id,
        recipientUserId: dto.recipientUserId,
        amount: dto.amount,
        currency: dto.currency,
      },
    });

    return this.toResult(result);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async getTransactionHistory(
    userId: string,
    query: TransactionQueryDto,
  ): Promise<PaginatedTransactions> {
    const wallet = await this.walletRepository.findByUserId(userId);
    const { items, total } = await this.transactionRepository.findByWalletPaginated(
      wallet.id,
      query.page,
      query.limit,
    );

    return {
      items: items.map(this.toResult),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async getTransaction(
    userId: string,
    transactionId: string,
  ): Promise<TransactionResult> {
    const wallet = await this.walletRepository.findByUserId(userId);
    const transaction = await this.transactionRepository.findById(transactionId);

    if (
      !transaction ||
      (transaction.senderWalletId !== wallet.id &&
        transaction.receiverWalletId !== wallet.id)
    ) {
      throw new ForbiddenException('Transaction not found.');
    }

    return this.toResult(transaction);
  }

  // ── Guards ─────────────────────────────────────────────────────────────────

  private assertSufficientBalance(
    available: Prisma.Decimal,
    required: Prisma.Decimal,
    userId: string,
  ): void {
    if (available.lessThan(required)) {
      this.audit.warn('WITHDRAWAL_FAILED', {
        userId,
        meta: {
          reason: 'INSUFFICIENT_BALANCE',
          available: available.toString(),
          required: required.toString(),
        },
      });
      throw new UnprocessableEntityException('Insufficient balance.');
    }
  }

  // ── Mapping ────────────────────────────────────────────────────────────────

  private toResult(transaction: any): TransactionResult {
    return {
      id: transaction.id,
      idempotencyKey: transaction.idempotencyKey,
      type: transaction.type,
      status: transaction.status,
      amount: transaction.amount,
      currency: transaction.currency,
      description: transaction.description ?? undefined,
      createdAt: transaction.createdAt,
      settledAt: transaction.settledAt ?? undefined,
    };
  }
}
