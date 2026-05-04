import { ConflictException, Injectable } from '@nestjs/common';
import { AccountStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '@app/prisma/prisma.service';

// ── Projection constants ───────────────────────────────────────────────────────

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

  async findById(id: string): Promise<UserWithWallet | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_PUBLIC_SELECT,
        wallet: { select: WALLET_SUMMARY_SELECT },
      },
    });
  }

  async findByIdWithPassword(
    id: string,
  ): Promise<{ id: string; password: string } | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, password: true },
    });
  }

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

  async checkPhoneTaken(phone: string) {
    return this.prisma.user.findFirst({
      where: { phone },
      select: { phone: true },
    });
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

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
   * Atomically closes a user account.
   *
   * Sequence inside a single serializable transaction:
   *   1. Re-reads wallet balances — authoritative check, not the service pre-read.
   *   2. Rejects with ConflictException if any balance bucket is non-zero.
   *   3. Sets User.status → CLOSED.
   *   4. Revokes all active refresh tokens.
   *
   * ## Balance comparison
   * Balances are Prisma.Decimal — JavaScript's `Number()` cannot faithfully
   * represent all Decimal(18,4) values (precision loss above 2^53). Comparing
   * with `Prisma.Decimal.isZero()` / `.greaterThan(0)` is exact for all values
   * within the column's range, which is what financial data requires.
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
        const zero = new Prisma.Decimal(0);
        const hasBalance =
          wallet.availableBalance.greaterThan(zero) ||
          wallet.lockedBalance.greaterThan(zero) ||
          wallet.pendingBalance.greaterThan(zero);

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
