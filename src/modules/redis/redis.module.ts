import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const logger = new Logger('RedisModule');

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const client = new Redis({
          host: config.get('redis.host'),
          port: config.get('redis.port'),
          password: config.get('redis.password'),
          retryStrategy: (times) => {
            if (times > 10) {
              logger.error(
                'Redis connection failed after 10 retries — giving up',
              );
              return null;
            }
            const delay = Math.min(times * 50, 2000);
            logger.warn(
              `Redis retry attempt ${times} — retrying in ${delay}ms`,
            );
            return delay;
          },
          maxRetriesPerRequest: 3,
          connectTimeout: 5000,
          lazyConnect: true,
        });

        client.on('connect', () => logger.log('Redis connected'));
        client.on('error', (err) => logger.error('Redis error', err));
        client.on('reconnecting', () => logger.warn('Redis reconnecting'));

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
