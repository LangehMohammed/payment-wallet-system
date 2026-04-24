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

  // Security (Strictly Required in Prod)
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRY: Joi.string()
    .pattern(/^[1-9]\d*[smhd]$/)
    .default('5m'),
  JWT_REFRESH_EXPIRY: Joi.string()
    .pattern(/^[1-9]\d*[smhd]$/)
    .default('7d'),

  MAX_SESSIONS: Joi.number().min(1).default(10),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),

  TOKEN_HASH_SECRET: Joi.string().min(32).required(),

  CACHE_ENCRYPTION_KEY: Joi.string()
    .length(64)
    .pattern(/^[0-9a-fA-F]+$/, 'hexadecimal')
    .required(),

  // Third-Party Providers
  // STRIPE_SECRET_KEY: Joi.string().when('ENV', {
  //   is: 'production',
  //   then: Joi.required(),
  // }),
});
