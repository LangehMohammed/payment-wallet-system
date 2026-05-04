import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, Currency, Prisma } from '@prisma/client';
import { PrismaService } from '@app/prisma/prisma.service';
import { KeysetCursor } from './interface';

// ── Projection constants ───────────────────────────────────────────────────────

const WALLET_SELECT = {
  id: true,
  userId: true,
  currency: true,
  status: true,
  availableBalance: true,
  lockedBalance: true,
  pendingBalance: true,
  createdAt: true,
  updatedAt: true,
} as const;

const LEDGER_ENTRY_SELECT = {
  id: true,
  walletId: true,
  transactionId: true,
  direction: true,
  amount: true,
  currency: true,
  balanceAfter: true,
  createdAt: true,
  transaction: {
    select: {
      type: true,
      status: true,
      description: true,
      senderWalletId: true,
      receiverWalletId: true,
    },
  },
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export type WalletRecord = Prisma.WalletGetPayload<{
  select: typeof WALLET_SELECT;
}>;

export type LedgerEntryRecord = Prisma.LedgerEntryGetPayload<{
  select: typeof LEDGER_ENTRY_SELECT;
}>;

export interface WalletPageResult {
  wallets: WalletRecord[];
  hasMore: boolean;
}

export interface LedgerPageResult {
  entries: LedgerEntryRecord[];
  hasMore: boolean;
}

export interface WalletFilters {
  status?: AccountStatus;
  currency?: Currency;
}

/**
 * Raw row shape returned by postgres for the FOR UPDATE query.
 * pg driver returns NUMERIC/DECIMAL columns as strings — never as JS numbers
 * or Prisma.Decimal instances. All Decimal fields are typed as `string` here
 * and coerced explicitly in `lockWallet` before being returned as WalletSnapshot.
 */
interface WalletLockRow {
  id: string;
  userId: string;
  currency: Currency;
  status: AccountStatus;
  availableBalance: string;
  lockedBalance: string;
  pendingBalance: string;
}

export interface WalletSnapshot {
  id: string;
  userId: string;
  currency: Currency;
  status: AccountStatus;
  availableBalance: Prisma.Decimal;
  lockedBalance: Prisma.Decimal;
  pendingBalance: Prisma.Decimal;
}

@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Wallet reads ───────────────────────────────────────────────────────────

  async findByUserId(userId: string): Promise<WalletRecord | null> {
    return this.prisma.wallet.findUnique({
      where: { userId },
      select: WALLET_SELECT,
    });
  }

  async findById(id: string): Promise<WalletRecord | null> {
    return this.prisma.wallet.findUnique({
      where: { id },
      select: WALLET_SELECT,
    });
  }

  /**
   * Cursor-paginated wallet list — admin endpoint.
   * Ordered by (createdAt DESC, id DESC) for stable keyset pagination.
   * Fetches limit + 1 rows to determine hasMore without a COUNT query.
   */
  async findAll(
    filters: WalletFilters,
    cursor: KeysetCursor | null,
    limit: number,
  ): Promise<WalletPageResult> {
    const where: Prisma.WalletWhereInput = {
      ...(filters.status !== undefined && { status: filters.status }),
      ...(filters.currency !== undefined && { currency: filters.currency }),
      ...(cursor !== null && {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          {
            createdAt: { equals: new Date(cursor.createdAt) },
            id: { lt: cursor.id },
          },
        ],
      }),
    };

    const rows = await this.prisma.wallet.findMany({
      where,
      select: WALLET_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const wallets = hasMore ? rows.slice(0, limit) : rows;

    return { wallets, hasMore };
  }

  // ── Ledger reads ───────────────────────────────────────────────────────────

  async findLedgerPage(
    walletId: string,
    cursor: KeysetCursor | null,
    limit: number,
  ): Promise<LedgerPageResult> {
    const where: Prisma.LedgerEntryWhereInput = {
      walletId,
      ...(cursor !== null && {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          {
            createdAt: { equals: new Date(cursor.createdAt) },
            id: { lt: cursor.id },
          },
        ],
      }),
    };

    const rows = await this.prisma.ledgerEntry.findMany({
      where,
      select: LEDGER_ENTRY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;

    return { entries, hasMore };
  }

  // ── Pessimistic lock ───────────────────────────────────────────────────────

  /**
   * Acquires a pessimistic row lock on the wallet for the duration of the
   * surrounding $transaction block. Must only be called inside a Prisma
   * interactive transaction.
   *
   * ## Type coercion — why this matters
   * Prisma's $queryRaw returns raw pg wire types. PostgreSQL sends NUMERIC /
   * DECIMAL columns as text strings over the wire. Without explicit coercion,
   * callers receive plain strings that look like Prisma.Decimal but are not —
   * calling `.lessThan()`, `.greaterThan()`, or any Decimal method on them
   * will throw `TypeError: available.lessThan is not a function` at runtime.
   *
   * Every Decimal field is wrapped in `new Prisma.Decimal()` here so that all
   * downstream guards (`assertSufficientBalance`, `assertCurrencyMatch`, etc.)
   * receive properly typed values and arithmetic is correct.
   */
  async lockWallet(
    walletId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WalletSnapshot> {
    const rows = await tx.$queryRaw<WalletLockRow[]>`
      SELECT
        id,
        "userId",
        currency,
        status,
        "availableBalance",
        "lockedBalance",
        "pendingBalance"
      FROM "Wallet"
      WHERE id = ${walletId}
      FOR UPDATE
    `;

    if (!rows.length) throw new NotFoundException('Wallet not found');

    const row = rows[0];

    return {
      id: row.id,
      userId: row.userId,
      currency: row.currency,
      status: row.status,
      availableBalance: new Prisma.Decimal(row.availableBalance),
      lockedBalance: new Prisma.Decimal(row.lockedBalance),
      pendingBalance: new Prisma.Decimal(row.pendingBalance),
    };
  }

  // ── Guards (called inside tx after lock) ───────────────────────────────────

  assertActive(wallet: WalletSnapshot): void {
    if (wallet.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException(
        `Wallet is ${wallet.status.toLowerCase()}. Contact support.`,
      );
    }
  }

  assertCurrencyMatch(wallet: WalletSnapshot, currency: Currency): void {
    if (wallet.currency !== currency) {
      throw new ForbiddenException(
        `Currency mismatch: wallet is ${wallet.currency}, transaction is ${currency}.`,
      );
    }
  }

  // ── Balance mutations (must be called inside a $transaction block) ─────────

  async creditAvailable(
    walletId: string,
    amount: Prisma.Decimal,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: { availableBalance: { increment: amount } },
      select: { availableBalance: true },
    });
    return updated.availableBalance;
  }

  async debitAvailableAndLock(
    walletId: string,
    amount: Prisma.Decimal,
    tx: Prisma.TransactionClient,
  ): Promise<{
    availableBalance: Prisma.Decimal;
    lockedBalance: Prisma.Decimal;
  }> {
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: {
        availableBalance: { decrement: amount },
        lockedBalance: { increment: amount },
      },
      select: { availableBalance: true, lockedBalance: true },
    });
    return updated;
  }

  async creditPending(
    walletId: string,
    amount: Prisma.Decimal,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: { pendingBalance: { increment: amount } },
      select: { pendingBalance: true },
    });
    return updated.pendingBalance;
  }

  async settlePending(
    walletId: string,
    amount: Prisma.Decimal,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: {
        pendingBalance: { decrement: amount },
        availableBalance: { increment: amount },
      },
      select: { availableBalance: true },
    });
    return updated.availableBalance;
  }

  async settleWithdrawal(
    walletId: string,
    amount: Prisma.Decimal,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: { lockedBalance: { decrement: amount } },
      select: { lockedBalance: true },
    });
    return updated.lockedBalance;
  }

  async debitAvailable(
    walletId: string,
    amount: Prisma.Decimal,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: { availableBalance: { decrement: amount } },
      select: { availableBalance: true },
    });
    return updated.availableBalance;
  }
}
