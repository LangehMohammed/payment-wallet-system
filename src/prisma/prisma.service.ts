import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

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
        ...(configService.get('app.env') !== 'production'
          ? [{ emit: 'event', level: 'query' } as Prisma.LogDefinition]
          : []),
      ],
    });

    this.$on('error', (e: Prisma.LogEvent) => {
      this.logger.error('Prisma error', e);
    });

    this.$on('warn', (e: Prisma.LogEvent) => {
      this.logger.warn('Prisma warning', e);
    });

    if (configService.get('app.env') !== 'production') {
      this.$on('query', (e: Prisma.QueryEvent) => {
        if (e.duration > 500) {
          this.logger.warn(`Slow query — ${e.duration}ms: ${e.query}`);
        }
      });
    }
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }
}
