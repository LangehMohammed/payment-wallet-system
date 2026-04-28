import { Injectable } from '@nestjs/common';
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
}
