import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  WalletRepository,
  WalletRecord,
  LedgerEntryRecord,
} from './wallet.repository';
import { AdminWalletQueryDto, LedgerQueryDto } from './dto';
import {
  KeysetCursor,
  LedgerEntryResponse,
  LedgerPage,
  WalletPage,
  WalletResponse,
} from './interface';
import { serializeDecimal } from './utils/decimal.util';

// ── UUID validation ────────────────────────────────────────────────────────────
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class WalletService {
  constructor(private readonly walletRepository: WalletRepository) {}

  // ── User-facing ────────────────────────────────────────────────────────────

  async getMyWallet(userId: string): Promise<WalletResponse> {
    const wallet = await this.walletRepository.findByUserId(userId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return this.serializeWallet(wallet);
  }

  async getMyLedger(
    userId: string,
    query: LedgerQueryDto,
  ): Promise<LedgerPage> {
    const wallet = await this.walletRepository.findByUserId(userId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return this.fetchLedgerPage(wallet.id, query);
  }

  // ── Admin-facing ───────────────────────────────────────────────────────────

  async getWalletById(id: string): Promise<WalletResponse> {
    const wallet = await this.walletRepository.findById(id);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return this.serializeWallet(wallet);
  }

  async getWalletLedger(
    walletId: string,
    query: LedgerQueryDto,
  ): Promise<LedgerPage> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return this.fetchLedgerPage(walletId, query);
  }

  async listWallets(query: AdminWalletQueryDto): Promise<WalletPage> {
    const { cursor: rawCursor, limit, status, currency } = query;

    const cursor = rawCursor ? this.decodeCursor(rawCursor) : null;

    const { wallets, hasMore } = await this.walletRepository.findAll(
      { status, currency },
      cursor,
      limit,
    );

    const nextCursor =
      hasMore && wallets.length > 0
        ? this.encodeCursor(wallets[wallets.length - 1])
        : null;

    return {
      wallets: wallets.map(this.serializeWallet),
      nextCursor,
      hasMore,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Shared ledger page fetch — used by both user-facing and admin paths.
   * Decodes the cursor, delegates to the repository, encodes the next cursor,
   * and maps all entries through the serializer before returning.
   */
  private async fetchLedgerPage(
    walletId: string,
    query: LedgerQueryDto,
  ): Promise<LedgerPage> {
    const { cursor: rawCursor, limit } = query;

    const cursor = rawCursor ? this.decodeCursor(rawCursor) : null;

    const { entries, hasMore } = await this.walletRepository.findLedgerPage(
      walletId,
      cursor,
      limit,
    );

    const nextCursor =
      hasMore && entries.length > 0
        ? this.encodeCursor(entries[entries.length - 1])
        : null;

    return {
      entries: entries.map(this.serializeLedgerEntry),
      nextCursor,
      hasMore,
    };
  }

  /**
   * Maps a raw WalletRecord from the repository into a WalletResponse.
   * Converts all Decimal fields to fixed-precision strings.
   * Arrow function preserves `this` context when passed to Array.map.
   */
  private serializeWallet = (wallet: WalletRecord): WalletResponse => ({
    id: wallet.id,
    userId: wallet.userId,
    currency: wallet.currency,
    status: wallet.status,
    availableBalance: serializeDecimal(wallet.availableBalance),
    lockedBalance: serializeDecimal(wallet.lockedBalance),
    pendingBalance: serializeDecimal(wallet.pendingBalance),
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });

  /**
   * Maps a raw LedgerEntryRecord into a LedgerEntryResponse.
   * Converts Decimal fields to strings and inlines the transaction summary.
   * Arrow function preserves `this` context when passed to Array.map.
   */
  private serializeLedgerEntry = (
    entry: LedgerEntryRecord,
  ): LedgerEntryResponse => ({
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: serializeDecimal(entry.amount),
    currency: entry.currency,
    balanceAfter: serializeDecimal(entry.balanceAfter),
    createdAt: entry.createdAt,
    transaction: {
      type: entry.transaction.type,
      status: entry.transaction.status,
      description: entry.transaction.description ?? null,
      senderWalletId: entry.transaction.senderWalletId ?? null,
      receiverWalletId: entry.transaction.receiverWalletId ?? null,
    },
  });

  /**
   * Encodes the last record on a page into an opaque base64 cursor string.
   * Accepts any record carrying `id` and `createdAt` — covers both
   * WalletRecord and LedgerEntryRecord without generics overhead.
   */
  private encodeCursor(record: { id: string; createdAt: Date }): string {
    const cursor: KeysetCursor = {
      createdAt: record.createdAt.toISOString(),
      id: record.id,
    };
    return Buffer.from(JSON.stringify(cursor)).toString('base64');
  }

  /**
   * Decodes and validates an opaque cursor string from the client.
   *
   * Validation layers (each throws BadRequestException on failure):
   *   1. Valid base64 — caught by DTO-level @IsBase64, re-checked defensively.
   *   2. Valid JSON — malformed JSON after base64 decode.
   *   3. Correct shape — both `createdAt` and `id` fields must be present.
   *   4. `createdAt` must be a parseable ISO date — NaN check on Date.parse.
   *   5. `id` must be a valid UUID — prevents cursor injection into the
   *      `id: { lt: cursor.id }` Prisma clause.
   *
   * All five layers throw BadRequestException — never a 500.
   */
  private decodeCursor(raw: string): KeysetCursor {
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf-8');
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('createdAt' in parsed) ||
      !('id' in parsed)
    ) {
      throw new BadRequestException('Invalid pagination cursor');
    }

    const { createdAt, id } = parsed as Record<string, unknown>;

    if (typeof createdAt !== 'string' || isNaN(Date.parse(createdAt))) {
      throw new BadRequestException('Invalid pagination cursor');
    }

    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      throw new BadRequestException('Invalid pagination cursor');
    }

    return { createdAt, id };
  }
}
