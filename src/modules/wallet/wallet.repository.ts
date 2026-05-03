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

  /**
   * Fetch a wallet by the owning user's ID.
   */
  async findByUserId(userId: string): Promise<WalletRecord | null> {
    return this.prisma.wallet.findUnique({
      where: { userId },
      select: WALLET_SELECT,
    });
  }

  /**
   * Fetch a wallet by its own ID — used by admin endpoints.
   * Returns null when the wallet does not exist.
   */
  async findById(id: string): Promise<WalletRecord | null> {
    return this.prisma.wallet.findUnique({
      where: { id },
      select: WALLET_SELECT,
    });
  }

  /**
   * Cursor-paginated wallet list — used by the admin list endpoint.
   *
   * Ordered by (createdAt DESC, id DESC) for stable keyset pagination.
   * Fetches limit + 1 rows to determine hasMore without a COUNT query.
   * Filters are additive (AND).
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

  /**
   * Cursor-paginated ledger entries for a given wallet.
   *
   * Uses the existing @@index([walletId, createdAt]) — the compound keyset
   * on (createdAt DESC, id DESC) keeps all reads on this index path.
   *
   * Fetches limit + 1 rows to determine hasMore without a COUNT query.
   * The repository receives a decoded KeysetCursor — encoding is the
   * service's responsibility.
   */
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

  /**
   * Pessimistic row lock — must be called inside a $transaction block.
   * Uses SELECT FOR UPDATE to block concurrent mutations on the same wallet row.
   */
  async lockWallet(
    walletId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WalletSnapshot> {
    // Raw lock — Prisma ORM does not expose FOR UPDATE natively
    const rows = await tx.$queryRaw<WalletSnapshot[]>`
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
    return rows[0];
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

  // ── Mutations (must be called inside a $transaction block) ─────────────────

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
