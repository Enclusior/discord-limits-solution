export default () => ({
  port: Number(process.env.PORT ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  postgres: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? 'discord_limits',
    user: process.env.POSTGRES_USER ?? 'discord_app',
    password: process.env.POSTGRES_PASSWORD ?? 'discord_app_password',
    poolSize: Number(process.env.POSTGRES_POOL_SIZE ?? 10),
  },
  outbox: {
    pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000),
    batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 100),
    leaseMs: Number(process.env.OUTBOX_LEASE_MS ?? 30000),
  },
  discord: {
    rateLimitPerSecond: Number(process.env.DISCORD_RATE_LIMIT_PER_SECOND ?? 2),
    workerConcurrency: Number(process.env.DISCORD_WORKER_CONCURRENCY ?? 10),
    requestTimeoutMs: Number(process.env.DISCORD_REQUEST_TIMEOUT_MS ?? 10000),
    retryMaxAttempts: Number(process.env.DISCORD_RETRY_MAX_ATTEMPTS ?? 5),
    retryBaseDelayMs: Number(process.env.DISCORD_RETRY_BASE_DELAY_MS ?? 1000),
    retryMaxDelayMs: Number(process.env.DISCORD_RETRY_MAX_DELAY_MS ?? 30000),
  },
});
