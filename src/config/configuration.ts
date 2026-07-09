export default () => ({
  app: {
    env: process.env.ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3000,
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') ?? [],
  },
  database: {
    url: process.env.DATABASE_URL,
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE, 10) || 10,
    slowQueryThresholdMs:
      parseInt(process.env.SLOW_QUERY_THRESHOLD_MS, 10) || 100,
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
    password: process.env.REDIS_PASSWORD,
  },
  swagger: {
    user: process.env.SWAGGER_USER,
    password: process.env.SWAGGER_PASSWORD,
  },
  braintree: {
    merchantId: process.env.BRAINTREE_MERCHANT_ID,
    publicKey: process.env.BRAINTREE_PUBLIC_KEY,
    privateKey: process.env.BRAINTREE_PRIVATE_KEY,
    environment: process.env.BRAINTREE_ENVIRONMENT || 'sandbox',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    connectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    connectReturnUrl: process.env.STRIPE_CONNECT_RETURN_URL,
    connectRefreshUrl: process.env.STRIPE_CONNECT_REFRESH_URL,
    connectFrontendReturnUrl: process.env.STRIPE_CONNECT_FRONTEND_RETURN_URL,
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    environment: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
  },
});
