import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { AuthRepository } from './auth.repository';
import { TokenService } from './token.service';
import { TokenDenylistService } from './token-denylist.service';
import Redis from 'ioredis';
import { AUTH_CONSTANTS } from './auth.constants';
import { CryptoService } from '../crypto/crypto.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly authRepository: AuthRepository,
    private readonly tokenDenylistService: TokenDenylistService,
    private readonly cryptoService: CryptoService,
    private readonly audit: AuditLogger,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  // ── Session state ──────────────────────────────────────────────────────────

  findTokenWithGrace(hash: string) {
    return this.authRepository.findRefreshTokenWithGrace(hash);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  async persistRefreshToken(
    userId: string,
    rawToken: string,
    userAgent?: string,
  ): Promise<void> {
    const hash = this.tokenService.hashToken(rawToken);
    const expiresAt = this.tokenService.getRefreshExpiry();
    const maxSessions = this.configService.get<number>('auth.maxSessions');

    const { evictedSessionId } = await this.authRepository.createSessionAtomic(
      userId,
      hash,
      expiresAt,
      maxSessions,
    );

    if (evictedSessionId) {
      void this.audit.warn('SESSION_EVICTED', {
        userId,
        userAgent,
        meta: { evictedSessionId },
      });
    }
  }

  // ── Rotation ───────────────────────────────────────────────────────────────

  async rotateToken(
    oldHash: string,
    newTokenData: { userId: string; tokenHash: string; expiresAt: Date },
    tokens: TokenPair,
  ): Promise<void> {
    await this.authRepository.rotateRefreshToken(oldHash, newTokenData);
    await this.storeRotationCache(oldHash, tokens);
  }

  // ── Revocation ─────────────────────────────────────────────────────────────

  async revokeAccessToken(jti: string): Promise<void> {
    const ttl = this.tokenService.getAccessTokenTtlSeconds();
    await this.tokenDenylistService.revoke(jti, ttl);
  }

  async revokeToken(hash: string): Promise<void> {
    await this.authRepository.revokeRefreshToken(hash);
  }

  async revokeAllTokens(userId: string): Promise<void> {
    await this.authRepository.revokeAllUserTokens(userId);
  }

  // ── Rotation cache ─────────────────────────────────────────────────────────

  /**
   * Stores the new token pair in the rotation cache keyed by the old token hash.
   *
   * ## Purpose
   * Handles the mobile/unreliable-network case where the client sends a refresh
   * request, the server rotates the token and responds, but the response is lost
   * in transit. The client retries with the old token — without the grace cache
   * this would trigger REUSE_DETECTED and log the user out. With it, the server
   * returns the same new pair that was issued on the first rotation.
   *
   * ## Security model for storing the access token in Redis
   * The cache entry contains a live access token (valid for ACCESS_TOKEN_TTL,
   * typically 5 minutes). This is an accepted, bounded risk:
   *
   *   - TTL is capped at REFRESH_TOKEN_GRACE_PERIOD_SECONDS (10 s) — far shorter
   *     than the access token's own lifetime. The window of exposure is 10 s.
   *   - The payload is encrypted with before storage. An attacker
   *     with raw Redis read access cannot recover the token without the key.
   *   - The cache key is the hash of the old refresh token — not
   *     guessable without knowledge of TOKEN_HASH_SECRET.
   *   - If Redis is fully compromised (key material AND data), an attacker gains
   *     at most 10 s of access token validity. The refresh token in the payload
   *     has already been rotated and is no longer usable.
   *
   * The alternative — re-signing a new access token on grace-period replay — is
   * equivalent in exposure (same TTL) but requires an extra signing round-trip
   * and produces a different access token than the one the client received,
   * which can cause subtle bugs in clients that cache the access token.
   *
   * ## Key namespace
   * Prefixed with `rcache:v1:` to allow safe key-space iteration and future
   * schema versioning without collisions against denylist or other Redis keys.
   */
  async storeRotationCache(
    oldTokenHash: string,
    tokens: TokenPair,
  ): Promise<void> {
    const key = this.rotationCacheKey(oldTokenHash);
    const ttl = AUTH_CONSTANTS.REFRESH_TOKEN_GRACE_PERIOD_SECONDS;

    // Sanity guard — TTL must be short. If the constant is misconfigured to a
    // large value, the security model above breaks down.
    if (ttl > 60) {
      this.logger.error(
        `REFRESH_TOKEN_GRACE_PERIOD_SECONDS is ${ttl}s — must not exceed 60s. ` +
          'Rotation cache write skipped.',
      );
      return;
    }

    try {
      const encrypted = this.cryptoService.encrypt(JSON.stringify(tokens));
      await this.redis.set(key, encrypted, 'EX', ttl);
    } catch (error) {
      this.logger.error(
        'Rotation cache write failed — grace-period idempotency unavailable',
        { error },
      );
    }
  }

  async getRotationCache(oldTokenHash: string): Promise<TokenPair | null> {
    const key = this.rotationCacheKey(oldTokenHash);
    try {
      const cached = await this.redis.get(key);
      if (!cached) return null;
      const plaintext = this.cryptoService.decrypt(cached);
      return JSON.parse(plaintext) as TokenPair;
    } catch (error) {
      this.logger.error(
        'Rotation cache read failed — failing closed on grace-period request',
        { error },
      );
      return null;
    }
  }

  async clearRotationCache(tokenHash: string): Promise<void> {
    try {
      await this.redis.del(this.rotationCacheKey(tokenHash));
    } catch (error) {
      this.logger.error(
        'Rotation cache clear failed — entry will expire naturally',
        { error },
      );
    }
  }

  /**
   * Rotation cache key format: `rcache:v1:<old-token-hash>`
   *
   * Versioned prefix allows future key schema changes without cross-contamination.
   * Scoped to `rcache:` to distinguish from `denylist:` keys in the same Redis db.
   */
  private rotationCacheKey(oldTokenHash: string): string {
    return `rcache:v1:${oldTokenHash}`;
  }
}
