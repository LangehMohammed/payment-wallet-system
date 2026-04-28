import {
  AccountStatus,
  Currency,
  EntryDirection,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';

// ── Cursor ─────────────────────────────────────────────────────────────────────

/**
 * Internal cursor shape — never exposed to clients directly.
 * Encoded as base64(JSON.stringify(KeysetCursor)) before leaving the server.
 * The `id` field breaks ties when multiple entries share the same `createdAt`.
 */
export interface KeysetCursor {
  createdAt: string; // ISO 8601 timestamp of the last entry on the previous page
  id: string; // UUID of the last entry — tiebreaker
}

// ── Wallet ─────────────────────────────────────────────────────────────────────

export interface WalletResponse {
  id: string;
  userId: string;
  currency: Currency;
  status: AccountStatus;
  // Financial amounts serialized as strings — JavaScript `number` (IEEE 754)
  // cannot represent all Decimal(18,4) values without silent precision loss.
  // Clients must use a decimal library for arithmetic. Format: "100.50".
  availableBalance: string;
  lockedBalance: string;
  pendingBalance: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Ledger ─────────────────────────────────────────────────────────────────────

/**
 * Minimal transaction context inlined into each ledger entry.
 * Gives the client enough to render a meaningful history row without
 * a separate transaction fetch.
 */
export interface LedgerTransactionSummary {
  type: TransactionType;
  status: TransactionStatus;
  description: string | null;
  senderWalletId: string | null;
  receiverWalletId: string | null;
}

export interface LedgerEntryResponse {
  id: string;
  walletId: string;
  transactionId: string;
  direction: EntryDirection;
  // Financial amounts serialized as strings — see WalletResponse for rationale.
  amount: string;
  currency: Currency;
  balanceAfter: string;
  createdAt: Date;
  transaction: LedgerTransactionSummary;
}

/**
 * Cursor-paginated ledger page envelope.
 *
 * `nextCursor` is null on the last page.
 * `hasMore` mirrors `nextCursor !== null` — provided as a convenience
 * so clients do not need to null-check the cursor to determine whether
 * to render a "load more" control.
 */
export interface LedgerPage {
  entries: LedgerEntryResponse[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Cursor-paginated wallet list envelope — used by the admin list endpoint.
 */
export interface WalletPage {
  wallets: WalletResponse[];
  nextCursor: string | null;
  hasMore: boolean;
}
