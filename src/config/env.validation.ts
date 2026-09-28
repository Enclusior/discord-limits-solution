import Joi from 'joi';

export const environmentValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  POSTGRES_HOST: Joi.string().default('localhost'),
  POSTGRES_PORT: Joi.number().port().default(5432),
  POSTGRES_DB: Joi.string().default('discord_limits'),
  POSTGRES_USER: Joi.string().default('discord_app'),
  POSTGRES_PASSWORD: Joi.string().default('discord_app_password'),
  POSTGRES_POOL_SIZE: Joi.number().integer().min(1).default(10),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(1000),
  OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).default(100),
  OUTBOX_LEASE_MS: Joi.number().integer().min(1000).default(30000),
  DISCORD_RATE_LIMIT_PER_SECOND: Joi.number().integer().min(1).default(2),
  DISCORD_RATE_LIMIT_CLEANUP_GRACE_MS: Joi.number()
    .integer()
    .min(0)
    .default(1000),
  DISCORD_WORKER_CONCURRENCY: Joi.number().integer().min(1).default(10),
  DISCORD_DISPATCH_LOCK_TTL_MS: Joi.number().integer().min(1000).default(15000),
  DISCORD_REQUEST_TIMEOUT_MS: Joi.number().integer().min(100).default(10000),
  DISCORD_RETRY_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  DISCORD_RETRY_BASE_DELAY_MS: Joi.number().integer().min(1).default(1000),
  DISCORD_RETRY_MAX_DELAY_MS: Joi.number().integer().min(1).default(30000),
});
