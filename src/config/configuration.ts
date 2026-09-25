export default () => ({
  port: Number(process.env.PORT ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
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
