import Joi from 'joi';

export const environmentValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  DISCORD_RATE_LIMIT_PER_SECOND: Joi.number().integer().min(1).default(2),
  DISCORD_WORKER_CONCURRENCY: Joi.number().integer().min(1).default(10),
  DISCORD_REQUEST_TIMEOUT_MS: Joi.number().integer().min(100).default(10000),
  DISCORD_RETRY_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  DISCORD_RETRY_BASE_DELAY_MS: Joi.number().integer().min(1).default(1000),
  DISCORD_RETRY_MAX_DELAY_MS: Joi.number().integer().min(1).default(30000),
});
