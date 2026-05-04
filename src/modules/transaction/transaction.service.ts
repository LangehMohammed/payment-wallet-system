import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Provider, Transaction } from '@prisma/client';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { PrismaService } from '@app/prisma/prisma.service';
import { TransactionRepository } from './transaction.repository';
import {
  DepositDto,
  TransferDto,
  TransactionQueryDto,
  WithdrawalDto,
} from './dto/transaction.dto';
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

/**
 * Wraps a mutation result with a replay flag so the controller can set the
 * `Idempotency-Replayed: true` response header without inspecting business data.
 *
 * `replayed: true`  — idempotency key already seen; original result returned.
 * `replayed: false` — new operation; result freshly created.
 *
 * The public API response body is always `TransactionResult`. The flag only
 * affects the response header, keeping the body shape stable for all clients.
 */
export interface MutationResult {
  data: TransactionResult;
  replayed: boolean;
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
   * Idempotency: duplicate idempotencyKey returns the original transaction
   * with `replayed: true` so the controller can signal this to the client.
   */
  async deposit(userId: string, dto: DepositDto): Promise<MutationResult> {
    const existing = await this.transactionRepository.findByIdempotencyKey(
      dto.idempotencyKey,
    );
    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: {
          idempotencyKey: dto.idempotencyKey,
          transactionId: existing.id,
        },
      });
      return { data: this.toResult(existing), replayed: true };
    }

    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const wallet = await this.walletRepository.findByUserId(userId);
      if (!wallet) throw new ForbiddenException('Wallet not found');

      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);

      const pendingBalanceAfter = await this.walletRepository.creditPending(
        locked.id,
        amount,
        tx,
      );

      return this.transactionRepository.initiateDeposit(
        {
          idempotencyKey: dto.idempotencyKey,
          type: 'DEPOSIT' as any,
          status: 'INITIATED' as any,
          amount,
          currency: dto.currency,
          description: dto.description,
          receiverWalletId: locked.id,
          provider: Provider.INTERNAL,
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
    });

    this.audit.log('DEPOSIT_INITIATED', {
      userId,
      meta: {
        transactionId: result.id,
        amount: dto.amount,
        currency: dto.currency,
      },
    });

    return { data: this.toResult(result), replayed: false };
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
   */
  async withdraw(userId: string, dto: WithdrawalDto): Promise<MutationResult> {
    const existing = await this.transactionRepository.findByIdempotencyKey(
      dto.idempotencyKey,
    );
    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: {
          idempotencyKey: dto.idempotencyKey,
          transactionId: existing.id,
        },
      });
      return { data: this.toResult(existing), replayed: true };
    }

    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const wallet = await this.walletRepository.findByUserId(userId);
      if (!wallet) throw new ForbiddenException('Wallet not found');

      const locked = await this.walletRepository.lockWallet(wallet.id, tx);

      this.walletRepository.assertActive(locked);
      this.walletRepository.assertCurrencyMatch(locked, dto.currency);
      this.assertSufficientBalance(locked.availableBalance, amount, userId);

      const { lockedBalance } =
        await this.walletRepository.debitAvailableAndLock(
          locked.id,
          amount,
          tx,
        );

      return this.transactionRepository.initiateWithdrawal(
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
    });

    this.audit.log('WITHDRAWAL_INITIATED', {
      userId,
      meta: {
        transactionId: result.id,
        amount: dto.amount,
        currency: dto.currency,
      },
    });

    return { data: this.toResult(result), replayed: false };
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
  async transfer(userId: string, dto: TransferDto): Promise<MutationResult> {
    if (userId === dto.recipientUserId) {
      throw new BadRequestException('Cannot transfer to yourself.');
    }

    const existing = await this.transactionRepository.findByIdempotencyKey(
      dto.idempotencyKey,
    );
    if (existing) {
      this.audit.log('IDEMPOTENT_REPLAY', {
        userId,
        meta: {
          idempotencyKey: dto.idempotencyKey,
          transactionId: existing.id,
        },
      });
      return { data: this.toResult(existing), replayed: true };
    }

    const amount = new Prisma.Decimal(dto.amount);

    // Resolve wallet IDs before the transaction — needed for deadlock-safe
    // lock ordering. These reads are stale by lock time, but IDs are immutable.
    const [senderWallet, receiverWallet] = await Promise.all([
      this.walletRepository.findByUserId(userId),
      this.walletRepository.findByUserId(dto.recipientUserId),
    ]);

    if (!senderWallet) throw new ForbiddenException('Sender wallet not found');
    if (!receiverWallet)
      throw new ForbiddenException('Recipient wallet not found');

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
      this.assertSufficientBalance(
        lockedSender.availableBalance,
        amount,
        userId,
      );

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

      return this.transactionRepository.executeTransfer(
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

    return { data: this.toResult(result), replayed: false };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async getTransactionHistory(
    userId: string,
    query: TransactionQueryDto,
  ): Promise<PaginatedTransactions> {
    const wallet = await this.walletRepository.findByUserId(userId);
    if (!wallet) throw new ForbiddenException('Wallet not found');

    const { items, total } =
      await this.transactionRepository.findByWalletPaginated(
        wallet.id,
        query.page,
        query.limit,
      );

    return {
      items: items.map((t) => this.toResult(t)),
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
    if (!wallet) throw new ForbiddenException('Wallet not found');

    const transaction =
      await this.transactionRepository.findById(transactionId);

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

  /**
   * Maps a Prisma Transaction record to the public TransactionResult shape.
   * Typed as `Transaction` (Prisma-generated) — not `any` — so the compiler
   * enforces valid field access and catches schema regressions.
   */
  private toResult(transaction: Transaction): TransactionResult {
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
