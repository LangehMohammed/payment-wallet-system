import { AuditLogger } from '@app/common/audit/audit-logger.service';
import {
  Injectable,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class TokenDenylistService {
  private readonly logger = new Logger(TokenDenylistService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly audit: AuditLogger,
  ) {}

  /**
   * Adds a JTI to the denylist with a TTL matching the token's remaining lifespan.
   *
   * Failure policy — SOFT FAIL:
   *   Redis unavailability must NOT block logout or password-change. The refresh
   *   token is already revoked in the database; the denylist only closes the
   *   narrow window where a short-lived access token could still be used.
   *   We log + audit the failure so operators are alerted, but we never throw.
   *
   *   Contrast with isRevoked(), which HARD FAILS (throws) — an unreadable
   *   denylist means we cannot confirm a token is safe, so we deny the request.
   *   The asymmetry is intentional: revocation failure is recoverable (token
   *   expires naturally), authentication failure is not.
   */
  async revoke(jti: string, expiresIn: number): Promise<void> {
    try {
      await this.redis.set(`denylist:${jti}`, '1', 'EX', expiresIn);
    } catch (error) {
      this.logger.error(
        'Redis denylist write failed — JTI not denylisted. ' +
          'Token will expire naturally. Operator action required.',
        { jti, error },
      );
      void this.audit.error('DENYLIST_FAILURE', {
        meta: { operation: 'revoke', jti },
      });
    }
  }

  /**
   * Returns true if the JTI is present in the denylist (token was revoked).
   *
   * Failure policy — HARD FAIL (fail-closed):
   *   If Redis is unreachable we cannot determine whether a token is revoked.
   *   Allowing the request would risk accepting a token that was explicitly
   *   invalidated, so we throw ServiceUnavailableException.
   */
  async isRevoked(jti: string): Promise<boolean> {
    try {
      const result = await this.redis.get(`denylist:${jti}`);
      return result !== null;
    } catch (error) {
      this.logger.error('Redis denylist read failed — failing closed', {
        jti,
        error,
      });
      void this.audit.error('DENYLIST_FAILURE', {
        meta: { operation: 'isRevoked', jti },
      });
      throw new ServiceUnavailableException(
        'Authentication service temporarily unavailable. Please try again.',
      );
    }
  }
}
