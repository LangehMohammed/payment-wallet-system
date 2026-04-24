import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma/prisma.service';
import { AUTH_CONSTANTS } from './auth.constants';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── User queries ──────────────────────────────────────────────────────────

  /**
   * Find a user by their email
   */
  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password: true,
        role: true,
        status: true,
      },
    });
  }

  /**
   * Find a user by their ID
   */
  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true, status: true },
    });
  }

  /**
   * Checks if an email or phone number is already taken by another user.
   * Returns the existing user's email and phone if found, otherwise null.
   */
  async checkEmailOrPhoneTaken(email: string, phone: string) {
    return this.prisma.user.findFirst({
      where: { OR: [{ email }, { phone }] },
      select: { email: true, phone: true },
    });
  }

  /**
   * Creates a new user and an associated wallet atomically.
   * Throws ConflictException if email or phone already exists.
   */
  async createUserWithWallet(data: Prisma.UserCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data,
          select: { id: true, email: true, role: true },
        });
        await tx.wallet.create({ data: { userId: user.id } });
        return user;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const metaString = JSON.stringify(error.meta).toLowerCase();
        const isPhone = metaString.includes('phone');
        const field = isPhone ? 'Phone number' : 'Email';
        throw new ConflictException(`${field} already in use`);
      }
      throw error;
    }
  }

  // ── Session (RefreshToken) queries ────────────────────────────────────────

  /**
   * Atomically rotates a refresh token: revokes the old token and creates a new one.
   * Returns the new token record.
   */
  async rotateRefreshToken(
    oldTokenHash: string,
    newTokenData: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({
        where: { tokenHash: oldTokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return tx.refreshToken.create({
        data: {
          userId: newTokenData.userId,
          tokenHash: newTokenData.tokenHash,
          expiresAt: newTokenData.expiresAt,
        },
      });
    });
  }

  /**
   * Finds a refresh token by its hash and checks its status with grace period handling.
   * Returns an object with the token and its status: 'ACTIVE', 'EXPIRED', 'GRACE_PERIOD', 'REUSE_DETECTED', or 'NOT_FOUND'.
   */
  async findRefreshTokenWithGrace(
    hash: string,
    leewaySeconds: number = AUTH_CONSTANTS.REFRESH_TOKEN_GRACE_PERIOD_SECONDS,
  ) {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
    });

    if (!token) return { status: 'NOT_FOUND' as const };

    if (token.expiresAt <= new Date()) {
      return { status: 'EXPIRED' as const, token };
    }

    if (!token.revokedAt) return { status: 'ACTIVE' as const, token };

    const diffInSeconds = (Date.now() - token.revokedAt.getTime()) / 1000;

    if (diffInSeconds <= leewaySeconds) {
      return { status: 'GRACE_PERIOD' as const, token };
    }

    return { status: 'REUSE_DETECTED' as const, token };
  }

  /**
   * Revokes a refresh token by its hash. Returns the number of tokens revoked (0 or 1).
   */
  async revokeRefreshToken(tokenHash: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Revokes all active tokens for a user. Returns the number of tokens revoked.
   */
  async revokeAllUserTokens(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Creates a new refresh token for a user, enforcing a maximum number of active sessions.
   * If the limit is exceeded, the oldest active session is revoked.
   * Uses an advisory lock to prevent race conditions when multiple sessions are created concurrently for the same user.
   * Returns the new session and the ID of any evicted session.
   */
  async createSessionAtomic(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    maxSessions: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Advisory lock scoped to this user — blocks concurrent session creation
      // for the same user only, other users are unaffected
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        ('x' || substring(replace(${userId}::text, '-', ''), 1, 8))::bit(32)::int,
        ('x' || substring(replace(${userId}::text, '-', ''), 9, 8))::bit(32)::int
      )`;

      const count = await tx.refreshToken.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });

      let evictedSessionId: string | null = null;

      if (count >= maxSessions) {
        const oldest = await tx.refreshToken.findFirst({
          where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (oldest) {
          await tx.refreshToken.update({
            where: { id: oldest.id },
            data: { revokedAt: new Date() },
          });
          evictedSessionId = oldest.id;
        }
      }

      const session = await tx.refreshToken.create({
        data: { userId, tokenHash, expiresAt },
        select: { id: true },
      });

      return { session, evictedSessionId };
    });
  }

  /**
   * Deletes all expired refresh tokens in batches to prevent long-running transactions and reduce DB load.
   * Returns the total number of tokens deleted.
   */
  async deleteAllExpiredTokens(
    batchSize = AUTH_CONSTANTS.CLEANUP_BATCH_SIZE,
  ): Promise<number> {
    let total = 0;
    while (true) {
      const result = await this.prisma.$executeRaw`
        WITH batch AS (
          SELECT id FROM "RefreshToken"
          WHERE "expiresAt" < NOW()
          LIMIT ${batchSize}
        )
        DELETE FROM "RefreshToken"
        WHERE id IN (SELECT id FROM batch)
      `;

      total += result;

      if (result < batchSize) break;

      // Yield between batches — prevents sustained DB pressure
      await new Promise((resolve) =>
        setTimeout(resolve, AUTH_CONSTANTS.CLEANUP_BATCH_DELAY_MS),
      );
    }
    return total;
  }
}
