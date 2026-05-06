import { Injectable } from '@nestjs/common';
import {
  Currency,
  EntryDirection,
  OutboxEvent,
  Prisma,
  Transaction,
  TransactionStatus,
  TransactionType,
  Provider,
} from '@prisma/client';
import { PrismaService } from '@app/prisma/prisma.service';

// ─── Input shapes ─────────────────────────────────────────────────────────────

export interface CreateTransactionInput {
  idempotencyKey: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: Prisma.Decimal;
  currency: Currency;
  description?: string;
  senderWalletId?: string;
  receiverWalletId?: string;
  provider?: Provider;
}

export interface CreateLedgerEntryInput {
  walletId: string;
  transactionId: string;
  direction: EntryDirection;
  amount: Prisma.Decimal;
  currency: Currency;
  balanceAfter: Prisma.Decimal;
}

export interface CreateOutboxEventInput {
  transactionId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
}

// ─── Repository ───────────────────────────────────────────────────────────────

@Injectable()
export class TransactionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Idempotency ────────────────────────────────────────────────────────────

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Transaction | null> {
    return this.prisma.transaction.findUnique({
      where: { idempotencyKey },
    });
  }

  // ── Atomic deposit flow ────────────────────────────────────────────────────

  /**
   * Initiates a deposit:
   *   1. Creates Transaction (INITIATED)
   *   2. Credits pendingBalance on receiver wallet
   *   3. Writes CREDIT LedgerEntry (pending)
   *   4. Writes OutboxEvent for provider call
   *
   * All writes are atomic. Balance update uses UPDATE + RETURNING
   * to avoid a separate SELECT round-trip.
   */
  async initiateDeposit(
    input: CreateTransactionInput,
    pendingBalanceAfter: Prisma.Decimal,
    outboxPayload: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Transaction> {
    const transaction = await tx.transaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.INITIATED,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        receiverWalletId: input.receiverWalletId,
        provider: input.provider,
      },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId: input.receiverWalletId!,
        transactionId: transaction.id,
        direction: EntryDirection.CREDIT,
        amount: input.amount,
        currency: input.currency,
        balanceAfter: pendingBalanceAfter,
      },
    });

    await tx.outboxEvent.create({
      data: {
        transactionId: transaction.id,
        eventType: 'DEPOSIT_INITIATED',
        payload: outboxPayload,
      },
    });

    return transaction;
  }

  /**
   * Settles a deposit:
   *   1. Updates Transaction → SETTLED + settledAt
   *   2. Moves pendingBalance → availableBalance (done in WalletRepository)
   *   3. Writes CREDIT LedgerEntry (settled, reflects new availableBalance)
   *   4. Writes OutboxEvent for settlement confirmation
   */
  async settleDeposit(
    transactionId: string,
    walletId: string,
    amount: Prisma.Decimal,
    currency: Currency,
    availableBalanceAfter: Prisma.Decimal,
    outboxPayload: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Transaction> {
    const transaction = await tx.transaction.update({
      where: { id: transactionId },
      data: {
        status: TransactionStatus.SETTLED,
        settledAt: new Date(),
      },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId,
        transactionId,
        direction: EntryDirection.CREDIT,
        amount,
        currency,
        balanceAfter: availableBalanceAfter,
      },
    });

    await tx.outboxEvent.create({
      data: {
        transactionId,
        eventType: 'DEPOSIT_SETTLED',
        payload: outboxPayload,
      },
    });

    return transaction;
  }

  // ── Atomic withdrawal flow ─────────────────────────────────────────────────

  /**
   * Initiates a withdrawal:
   *   1. Creates Transaction (INITIATED)
   *   2. Debits availableBalance, credits lockedBalance (done in WalletRepository)
   *   3. Writes DEBIT LedgerEntry (locked)
   *   4. Writes OutboxEvent for provider call
   */
  async initiateWithdrawal(
    input: CreateTransactionInput,
    lockedBalanceAfter: Prisma.Decimal,
    outboxPayload: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Transaction> {
    const transaction = await tx.transaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.INITIATED,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        senderWalletId: input.senderWalletId,
        provider: input.provider,
      },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId: input.senderWalletId!,
        transactionId: transaction.id,
        direction: EntryDirection.DEBIT,
        amount: input.amount,
        currency: input.currency,
        balanceAfter: lockedBalanceAfter,
      },
    });

    await tx.outboxEvent.create({
      data: {
        transactionId: transaction.id,
        eventType: 'WITHDRAWAL_INITIATED',
        payload: outboxPayload,
      },
    });

    return transaction;
  }

  // ── Atomic transfer flow ───────────────────────────────────────────────────

  /**
   * Executes a full P2P transfer in one atomic transaction:
   *   1. Creates Transaction (SETTLED — internal transfers settle instantly)
   *   2. Debits sender availableBalance (done in WalletRepository)
   *   3. Credits receiver availableBalance (done in WalletRepository)
   *   4. Writes DEBIT LedgerEntry for sender
   *   5. Writes CREDIT LedgerEntry for receiver
   *   6. Writes OutboxEvent for notification/event dispatch
   *
   * Double-entry: DEBIT(sender) + CREDIT(receiver) — net = 0.
   */
  async executeTransfer(
    input: CreateTransactionInput,
    senderBalanceAfter: Prisma.Decimal,
    receiverBalanceAfter: Prisma.Decimal,
    outboxPayload: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Transaction> {
    const transaction = await tx.transaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.SETTLED,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        senderWalletId: input.senderWalletId,
        receiverWalletId: input.receiverWalletId,
        provider: Provider.INTERNAL,
        settledAt: new Date(),
      },
    });

    // Sender DEBIT
    await tx.ledgerEntry.create({
      data: {
        walletId: input.senderWalletId!,
        transactionId: transaction.id,
        direction: EntryDirection.DEBIT,
        amount: input.amount,
        currency: input.currency,
        balanceAfter: senderBalanceAfter,
      },
    });

    // Receiver CREDIT
    await tx.ledgerEntry.create({
      data: {
        walletId: input.receiverWalletId!,
        transactionId: transaction.id,
        direction: EntryDirection.CREDIT,
        amount: input.amount,
        currency: input.currency,
        balanceAfter: receiverBalanceAfter,
      },
    });

    await tx.outboxEvent.create({
      data: {
        transactionId: transaction.id,
        eventType: 'TRANSFER_SETTLED',
        payload: outboxPayload,
      },
    });

    return transaction;
  }

  // ── Status mutations ───────────────────────────────────────────────────────

  async updateStatus(
    transactionId: string,
    status: TransactionStatus,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.transaction.update({
      where: { id: transactionId },
      data: {
        status,
        ...(status === TransactionStatus.SETTLED
          ? { settledAt: new Date() }
          : {}),
      },
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Transaction | null> {
    return this.prisma.transaction.findUnique({ where: { id } });
  }

  async findByWalletPaginated(
    walletId: string,
    page: number,
    limit: number,
  ): Promise<{ items: Transaction[]; total: number }> {
    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where: {
          OR: [{ senderWalletId: walletId }, { receiverWalletId: walletId }],
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.transaction.count({
        where: {
          OR: [{ senderWalletId: walletId }, { receiverWalletId: walletId }],
        },
      }),
    ]);
    return { items, total };
  }

  async findPendingOutboxEvents(limit = 100): Promise<OutboxEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: { deliveredAt: null, retryCount: { lt: 5 } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async markOutboxDelivered(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { deliveredAt: new Date() },
    });
  }

  async incrementOutboxRetry(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { retryCount: { increment: 1 } },
    });
  }
}
