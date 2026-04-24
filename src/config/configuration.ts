export default () => ({
  app: {
    env: process.env.ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3000,
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') ?? [],
  },
  database: {
    url: process.env.DATABASE_URL,
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE, 10) || 10,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY ?? '5m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? '7d',
  },
  auth: {
    maxSessions: parseInt(process.env.MAX_SESSIONS, 10) || 10,
  },
  token: {
    hashSecret: process.env.TOKEN_HASH_SECRET,
  },
  cache: {
    encryptionKey: process.env.CACHE_ENCRYPTION_KEY,
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  },
});
