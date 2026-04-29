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
   * Revokes a token by adding its JTI to the denylist with an expiration time.
   * - Stores the JTI in Redis with a value of '1' and sets an expiration based on the token's remaining lifespan.
   */
  async revoke(jti: string, expiresIn: number): Promise<void> {
    try {
      await this.redis.set(`denylist:${jti}`, '1', 'EX', expiresIn);
    } catch (error) {
      this.logger.error('Redis denylist write failed — JTI not denylisted', {
        jti,
        error,
      });

      void this.audit.error('DENYLIST_FAILURE', {
        meta: { operation: 'revoke', jti },
      });
      throw error;
    }
  }

  /**
   * Checks if a token's JTI is present in the denylist, indicating it has been revoked.
   * - Queries Redis for the presence of the JTI key and returns true if found, false otherwise.
   * - Implements a fail-closed approach by treating any Redis errors as an indication that the token should be considered revoked.
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
