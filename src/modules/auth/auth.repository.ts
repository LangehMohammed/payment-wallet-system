import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma/prisma.service';
import { AUTH_CONSTANTS } from './auth.constants';
import { Prisma, Role } from '@prisma/client';

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateUserInput {
  name: string;
  email: string;
  phone: string;
  password: string;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── User queries ──────────────────────────────────────────────────────────

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

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true, status: true },
    });
  }

  async checkEmailOrPhoneTaken(email: string, phone: string) {
    return this.prisma.user.findFirst({
      where: { OR: [{ email }, { phone }] },
      select: { email: true, phone: true },
    });
  }

  /**
   * Atomically creates a user (role=USER, status=ACTIVE by default from schema)
   * and an associated wallet inside a single transaction.
   *
   * Throws ConflictException on unique constraint violations (email or phone).
   * Role and status are intentionally not settable here — use the admin
   * endpoint for privilege escalation after account creation.
   */
  async createUserWithWallet(data: CreateUserInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: data.name,
            email: data.email,
            phone: data.phone,
            password: data.password,
          },
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
   * Finds a refresh token by hash and classifies its state.
   *
   * State machine:
   *   NOT_FOUND     — hash unknown; treat as invalid.
   *   EXPIRED       — token exists but past expiresAt; treat as invalid.
   *   ACTIVE        — not revoked, not expired; normal rotation path.
   *   GRACE_PERIOD  — revoked within leewaySeconds; allow idempotent replay.
   *   REUSE_DETECTED — revoked beyond leeway; potential token theft, nuke all sessions.
   *
   * ## Ordering rationale
   * Expiry is checked BEFORE revocation so that a token which is both expired
   * AND revoked is classified as EXPIRED (invalid, no action needed) rather
   * than REUSE_DETECTED (which would trigger a nuclear session wipe on a
   * benign condition — an old token that simply wasn't cleaned up yet).
   */
  async findRefreshTokenWithGrace(
    hash: string,
    leewaySeconds: number = AUTH_CONSTANTS.REFRESH_TOKEN_GRACE_PERIOD_SECONDS,
  ) {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
    });

    if (!token) return { status: 'NOT_FOUND' as const };

    // Expired tokens are unconditionally invalid regardless of revocation state.
    if (token.expiresAt <= new Date()) {
      return { status: 'EXPIRED' as const, token };
    }

    // Token is within its valid lifetime — check revocation.
    if (!token.revokedAt) return { status: 'ACTIVE' as const, token };

    const secondsSinceRevocation =
      (Date.now() - token.revokedAt.getTime()) / 1000;

    if (secondsSinceRevocation <= leewaySeconds) {
      return { status: 'GRACE_PERIOD' as const, token };
    }

    return { status: 'REUSE_DETECTED' as const, token };
  }

  async revokeRefreshToken(tokenHash: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async revokeAllUserTokens(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Creates a new session, evicting the oldest active session if the user
   * has reached `maxSessions`. Uses a pg advisory lock scoped to the user's
   * UUID to prevent concurrent session creation races for the same user.
   */
  async createSessionAtomic(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    maxSessions: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
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

      await new Promise((resolve) =>
        setTimeout(resolve, AUTH_CONSTANTS.CLEANUP_BATCH_DELAY_MS),
      );
    }
    return total;
  }
}
