import { ConflictException, Injectable } from '@nestjs/common';
import { AccountStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '@app/prisma/prisma.service';

// ── Projection constants ───────────────────────────────────────────────────────
// Defined once here — never risk accidentally selecting `password` elsewhere.

const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const WALLET_SUMMARY_SELECT = {
  id: true,
  currency: true,
  status: true,
  availableBalance: true,
  lockedBalance: true,
  pendingBalance: true,
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export type UserProfile = Prisma.UserGetPayload<{
  select: typeof USER_PUBLIC_SELECT;
}>;

export type UserWithWallet = Prisma.UserGetPayload<{
  select: typeof USER_PUBLIC_SELECT & {
    wallet: { select: typeof WALLET_SUMMARY_SELECT };
  };
}>;

export interface PaginatedUsers {
  users: UserProfile[];
  total: number;
}

export interface UserFilters {
  status?: AccountStatus;
  role?: Role;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Fetch a user's public profile with wallet summary.
   * Returns null when the user does not exist — callers decide the HTTP response.
   */
  async findById(id: string): Promise<UserWithWallet | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_PUBLIC_SELECT,
        wallet: { select: WALLET_SUMMARY_SELECT },
      },
    });
  }

  /**
   * Fetches id + password hash only — used exclusively by changePassword.
   * Returns null when the user does not exist.
   */
  async findByIdWithPassword(
    id: string,
  ): Promise<{ id: string; password: string } | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, password: true },
    });
  }

  /**
   * Paginated list of users — single round-trip via $transaction([findMany, count]).
   * Filters are additive (AND). Ordered by createdAt DESC for stable pagination.
   */
  async findAll(
    filters: UserFilters,
    { page, limit }: PaginationParams,
  ): Promise<PaginatedUsers> {
    const where: Prisma.UserWhereInput = {
      ...(filters.status !== undefined && { status: filters.status }),
      ...(filters.role !== undefined && { role: filters.role }),
    };

    const skip = (page - 1) * limit;

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total };
  }

  /**
   * Checks if a phone number is already taken by another user.
   * Returns the existing user's phone if found, otherwise null.
   */
  async checkPhoneTaken(phone: string) {
    return this.prisma.user.findFirst({
      where: { phone },
      select: { phone: true },
    });
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Update mutable profile fields (name, phone).
   * Catches P2002 on phone uniqueness — surfaces as ConflictException.
   * Email is intentionally excluded: email change is a separate, verified flow.
   */
  async updateProfile(
    id: string,
    data: { name?: string; phone?: string },
  ): Promise<UserProfile> {
    try {
      return await this.prisma.user.update({
        where: { id },
        data,
        select: USER_PUBLIC_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Phone number already in use');
      }
      throw error;
    }
  }

  /**
   * Atomically updates the password and revokes all active refresh tokens.
   *
   * Both writes are wrapped in a single transaction — if either fails,
   * neither is committed.
   */
  async updatePasswordAndRevokeSessions(
    id: string,
    hashedPassword: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { password: hashedPassword },
        select: { id: true },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /**
   * Admin-only: update status and/or role on any user.
   * Business-rule enforcement (e.g. balance check before CLOSED) happens
   * in the service — this method executes the mutation unconditionally.
   */
  async updateStatusOrRole(
    id: string,
    data: { status?: AccountStatus; role?: Role },
  ): Promise<UserProfile> {
    return this.prisma.user.update({
      where: { id },
      data,
      select: USER_PUBLIC_SELECT,
    });
  }

  /**
   * Atomically closes a user account:
   *   1. Re-reads wallet balances inside the transaction
   *   2. Rejects with ConflictException if any funds remain
   *   3. Sets User.status → CLOSED
   *   4. Revokes all active refresh tokens
   *
   * Uses the interactive transaction form so conditional logic can execute
   * inside the same serializable unit. The caller's pre-check in the service
   * is a fast-path guard; this is the authoritative enforcement.
   */
  async closeAccount(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId },
        select: {
          availableBalance: true,
          lockedBalance: true,
          pendingBalance: true,
        },
      });

      if (wallet) {
        const hasBalance =
          Number(wallet.availableBalance) > 0 ||
          Number(wallet.lockedBalance) > 0 ||
          Number(wallet.pendingBalance) > 0;

        if (hasBalance) {
          throw new ConflictException(
            'Account cannot be closed while funds remain. ' +
              'Please withdraw all funds before closing your account.',
          );
        }
      }

      await tx.user.update({
        where: { id: userId },
        data: { status: AccountStatus.CLOSED },
        select: { id: true },
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}
