import { PrismaService } from '@app/prisma/prisma.service';
import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class HealthService {
  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Checks the health of the application by verifying the connectivity to Redis and the database.
   * Returns an object indicating the status of each service and an overall status.
   */
  async check() {
    const [redis, database] = await Promise.allSettled([
      this.checkRedis(),
      this.checkDatabase(),
    ]);

    const status = {
      redis: redis.status === 'fulfilled' ? 'ok' : 'degraded',
      database: database.status === 'fulfilled' ? 'ok' : 'degraded',
    };

    const isHealthy = Object.values(status).every((s) => s === 'ok');

    return { status: isHealthy ? 'ok' : 'degraded', services: status };
  }

  private async checkRedis(): Promise<void> {
    await this.redis.ping();
  }

  private async checkDatabase(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
