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

  /**
   * Delegates to the repository grace-period lookup.
   * Centralised here so all session state reads go through SessionService —
   * AuthService has no reason to know about token hashes or grace windows.
   */
  findTokenWithGrace(hash: string) {
    return this.authRepository.findRefreshTokenWithGrace(hash);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * Hashes and stores the refresh token in the database, enforcing max session limits.
   * If max sessions are exceeded, the oldest session is evicted and an audit log is created.
   */
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

  /**
   * Atomically revokes the old token and creates the new one in the DB,
   * then stores the encrypted token pair in the rotation cache.
   */
  async rotateToken(
    oldHash: string,
    newTokenData: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
    },
    tokens: TokenPair,
  ): Promise<void> {
    await this.authRepository.rotateRefreshToken(oldHash, newTokenData);
    await this.storeRotationCache(oldHash, tokens);
  }

  // ── Revocation ─────────────────────────────────────────────────────────────

  /**
   * Revokes the access token JTI in Redis.
   */
  async revokeAccessToken(jti: string): Promise<void> {
    const ttl = this.tokenService.getAccessTokenTtlSeconds();
    await this.tokenDenylistService.revoke(jti, ttl);
  }

  /**
   * Revokes a single refresh token by hash.
   */
  async revokeToken(hash: string): Promise<void> {
    await this.authRepository.revokeRefreshToken(hash);
  }

  /**
   * Revokes all active refresh tokens for a user.
   * Used on TOKEN_REUSE_DETECTED and logoutAll.
   */
  async revokeAllTokens(userId: string): Promise<void> {
    await this.authRepository.revokeAllUserTokens(userId);
  }

  // ── Rotation cache ─────────────────────────────────────────────────────────

  /**
   * Stores the new token pair in the rotation cache keyed by the old token hash.
   * This allows for a grace period where the old refresh token can still be used
   * to obtain the new tokens if the client retries due to a network error, preventing unnecessary logouts.
   */
  async storeRotationCache(
    oldTokenHash: string,
    tokens: TokenPair,
  ): Promise<void> {
    const key = this.rotationCacheKey(oldTokenHash);
    const ttl = AUTH_CONSTANTS.REFRESH_TOKEN_GRACE_PERIOD_SECONDS;
    try {
      // Encrypt the token pair before storing in Redis for added security
      const plaintext = JSON.stringify(tokens);
      const encrypted = this.cryptoService.encrypt(plaintext);
      await this.redis.set(key, encrypted, 'EX', ttl);
    } catch (error) {
      this.logger.error(
        'Rotation cache write failed — grace-period idempotency unavailable',
        { error },
      );
    }
  }

  /**
   * Retrieves the token pair from the rotation cache if it exists and is valid.
   * Returns null if not found or on error (failing closed).
   */
  async getRotationCache(oldTokenHash: string): Promise<TokenPair | null> {
    const key = this.rotationCacheKey(oldTokenHash);
    try {
      const cached = await this.redis.get(key);
      if (!cached) return null;

      // Decrypt the cached token pair before returning
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

  /**
   * Clears the rotation cache entry for the given old token hash.
   * This is typically called after a successful token rotation to clean up the cache.
   */
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
   * Generates the Redis key for the rotation cache based on the old token hash.
   */
  private rotationCacheKey(oldTokenHash: string): string {
    return `rotation_cache:${oldTokenHash}`;
  }
}
