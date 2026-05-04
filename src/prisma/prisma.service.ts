import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly isDev: boolean;
  private readonly slowQueryThresholdMs: number;

  constructor(private readonly configService: ConfigService) {
    const adapter = new PrismaPg({
      connectionString: configService.get<string>('database.url'),
      max: configService.get<number>('database.poolSize'),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    super({
      adapter,
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
        // Query events emitted in all environments — we gate what we log
        // from them, not whether we receive them.
        { emit: 'event', level: 'query' },
      ],
    });

    this.isDev = configService.get<string>('app.env') === 'development';

    /**
     * Slow-query threshold — configurable per environment.
     *
     * Recommended values:
     *   development : 500ms  (loose — local DB is usually co-located)
     *   staging     : 200ms  (tighter — catches regressions before prod)
     *   production  : 100ms  (strict — payment queries must be fast)
     *
     * Set SLOW_QUERY_THRESHOLD_MS in the environment to override the default.
     */
    this.slowQueryThresholdMs =
      configService.get<number>('database.slowQueryThresholdMs') ?? 100;

    this.$on('error', (e: Prisma.LogEvent) => {
      this.logger.error('Prisma error', e);
    });

    this.$on('warn', (e: Prisma.LogEvent) => {
      this.logger.warn('Prisma warning', e);
    });

    this.$on('query', (e: Prisma.QueryEvent) => {
      if (e.duration <= this.slowQueryThresholdMs) return;

      if (this.isDev) {
        /**
         * Development: log the full query text to aid debugging.
         *
         * `e.params` is intentionally excluded even here — it can contain
         * actual field values submitted by the user. Query text alone is
         * sufficient to identify which query is slow.
         */
        this.logger.warn(
          `Slow query — ${e.duration}ms (threshold: ${this.slowQueryThresholdMs}ms)\n${e.query}`,
        );
      } else {
        /**
         * Non-development: log only duration and a query fingerprint.
         *
         * The fingerprint is a 8-char hex prefix of SHA-256(query text).
         * It is stable across executions of the same query (same SQL template,
         * same parameter count) so operators can correlate repeated offenders
         * across log lines and time windows without any SQL being stored in
         * the log aggregator.
         *
         * We deliberately do NOT log:
         *   - e.query  : exposes schema shape, table names, column names
         *   - e.params : exposes actual data values — never log these
         *   - e.target : the Prisma datasource name (low value, avoid noise)
         */
        const fingerprint = crypto
          .createHash('sha256')
          .update(e.query)
          .digest('hex')
          .slice(0, 8);

        this.logger.warn(
          `Slow query — ${e.duration}ms (threshold: ${this.slowQueryThresholdMs}ms) fingerprint=${fingerprint}`,
        );
      }
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log(
      `Database connected (slow-query threshold: ${this.slowQueryThresholdMs}ms)`,
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }
}
