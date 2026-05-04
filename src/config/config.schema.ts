import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // Environment
  ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  ALLOWED_ORIGINS: Joi.string()
    .custom((value, helpers) => {
      const origins = value.split(',').map((o: string) => o.trim());
      if (origins.includes('*')) {
        return helpers.error('any.invalid', {
          message:
            'Wildcard origin (*) cannot be used with credentialed requests',
        });
      }
      return value;
    })
    .when('ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

  // Database
  DATABASE_URL: Joi.string().required(),
  DATABASE_POOL_SIZE: Joi.number().min(1).max(100).default(10),
  /**
   * Slow-query warning threshold in milliseconds.
   * Recommended per environment:
   *   development : 500   (loose — local DB co-located, latency is artificial)
   *   staging     : 200   (catches regressions before they reach production)
   *   production  : 100   (strict — payment queries must complete quickly)
   *
   * Minimum enforced at 10ms to prevent log flooding from trivially fast
   * queries that exceed an unrealistically tight threshold.
   */
  SLOW_QUERY_THRESHOLD_MS: Joi.number().min(10).default(100),

  // Security
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRY: Joi.string()
    .pattern(/^[1-9]\d*[smhd]$/)
    .default('5m'),
  JWT_REFRESH_EXPIRY: Joi.string()
    .pattern(/^[1-9]\d*[smhd]$/)
    .default('7d'),

  MAX_SESSIONS: Joi.number().min(1).default(10),

  // Redis — password required in all environments (defense-in-depth).
  // Even on internal Docker networks, unauthenticated Redis is a lateral-
  // movement risk if any container is compromised.
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().min(16).required(),

  TOKEN_HASH_SECRET: Joi.string().min(32).required(),

  CACHE_ENCRYPTION_KEY: Joi.string()
    .length(64)
    .pattern(/^[0-9a-fA-F]+$/, 'hexadecimal')
    .required(),

  // Swagger — required in non-production to gate the UI behind basic auth.
  // Not required in production because Swagger is disabled entirely there.
  SWAGGER_USER: Joi.string().when('ENV', {
    is: Joi.valid('development', 'test'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  SWAGGER_PASSWORD: Joi.string().min(16).when('ENV', {
    is: Joi.valid('development', 'test'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  // Third-Party Providers
  // STRIPE_SECRET_KEY: Joi.string().when('ENV', {
  //   is: 'production',
  //   then: Joi.required(),
  // }),
});
