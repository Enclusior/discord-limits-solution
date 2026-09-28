import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { RateLimiterService } from './rate-limiter.service';

const describeRedisIntegration =
  process.env.RUN_REDIS_INTEGRATION === '1' ? describe : describe.skip;

describeRedisIntegration('RateLimiterService Redis integration', () => {
  const channelId = `slot-test-${randomUUID()}`;
  let redis: Redis;
  let limiter: RateLimiterService;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_TEST_HOST ?? 'localhost',
      port: Number(process.env.REDIS_TEST_PORT ?? 6380),
      maxRetriesPerRequest: null,
    });
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'discord.rateLimitPerSecond') return 2;
        if (key === 'discord.rateLimitCleanupGraceMs') return 1000;
        throw new Error(`Unexpected config key: ${key}`);
      },
    } as ConfigService;
    limiter = new RateLimiterService(redis, config);
  });

  afterAll(async () => {
    if (redis) {
      await redis.del(`discord-webhook:ratelimit:${channelId}`);
      await redis.quit();
    }
  });

  it('keeps a late event behind all six already-reserved slots', async () => {
    const reservations = [];
    for (let index = 0; index < 6; index += 1) {
      reservations.push(await limiter.reserve(channelId));
    }

    expect(reservations[0].delayMs).toBeLessThan(100);
    expect(reservations[5].reservedAt - reservations[0].reservedAt).toBe(2500);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const seventh = await limiter.reserve(channelId);
    expect(seventh.delayMs).toBeGreaterThan(1500);
    expect(seventh.reservedAt).toBe(reservations[5].reservedAt + 500);
  });

  it('keeps reservation state isolated between channels', async () => {
    const channelA = `${channelId}-a`;
    const channelB = `${channelId}-b`;
    try {
      await limiter.reserve(channelA);
      await limiter.reserve(channelA);
      const reservationB = await limiter.reserve(channelB);

      expect(reservationB.delayMs).toBeLessThan(100);
    } finally {
      await redis.del(
        `discord-webhook:ratelimit:${channelA}`,
        `discord-webhook:ratelimit:${channelB}`,
      );
    }
  });

  it('expires an idle channel key only after its reserved slot and grace', async () => {
    const idleChannel = `${channelId}-idle`;
    const key = `discord-webhook:ratelimit:${idleChannel}`;
    try {
      await limiter.reserve(idleChannel);

      const ttlMs = await redis.pttl(key);
      expect(ttlMs).toBeGreaterThan(1000);
      expect(ttlMs).toBeLessThanOrEqual(1600);

      await new Promise((resolve) => setTimeout(resolve, 1700));
      expect(await redis.exists(key)).toBe(0);
    } finally {
      await redis.del(key);
    }
  });
});
