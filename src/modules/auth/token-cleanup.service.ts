import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Redis } from 'ioredis';
import { AuthRepository } from './auth.repository';

const CLEANUP_LOCK_KEY = 'locks:token_cleanup';

// Lock TTL must exceed the maximum expected cleanup duration.
// Worst case: 1 M expired tokens / 1 000 per batch * 100 ms delay = ~100 s.
// 10 minutes provides a 6× safety margin while ensuring a crashed instance's
// lock expires before operators would investigate a missed cleanup window.
// If the process is killed mid-run (SIGKILL), the lock expires automatically
// and the next instance can proceed after at most CLEANUP_LOCK_TTL_SECONDS.
const CLEANUP_LOCK_TTL_SECONDS = 10 * 60; // 10 minutes

@Injectable()
export class TokenCleanupService {
  private readonly logger = new Logger(TokenCleanupService.name);

  constructor(
    private readonly authRepository: AuthRepository,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  /**
   * Scheduled task that runs daily at midnight to clean up expired tokens.
   * - Uses a distributed lock in Redis to ensure only one instance performs cleanup.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredTokens(): Promise<void> {
    const acquired = await this.redis.set(
      CLEANUP_LOCK_KEY,
      '1',
      'EX',
      CLEANUP_LOCK_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      this.logger.log('Token cleanup skipped — another instance is running it');
      return;
    }

    try {
      const deleted = await this.authRepository.deleteAllExpiredTokens();
      this.logger.log(
        `Token cleanup complete — ${deleted} expired tokens removed`,
      );
    } catch (error) {
      this.logger.error('Token cleanup failed', error);
    } finally {
      await this.redis.del(CLEANUP_LOCK_KEY);
    }
  }
}
