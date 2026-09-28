import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { RateLimiterService } from './rate-limiter.service';

const describeRedisIntegration =
  process.env.RUN_REDIS_INTEGRATION === '1' ? describe : describe.skip;

describeRedisIntegration('RateLimiterService Redis integration', () => {
  const runId = randomUUID();
  const usedChannels: string[] = [];
  let redis: Redis;
  let limiter: RateLimiterService;

  const channel = (name: string): string => {
    const channelId = `it-${runId}-${name}`;
    usedChannels.push(channelId);
    return channelId;
  };
  const redisNow = async (): Promise<number> => {
    const [seconds, microseconds] = await redis.time();
    return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

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
    if (!redis) return;
    await redis.del(
      ...usedChannels.map((id) => `discord-webhook:channel:${id}`),
    );
    await redis.quit();
  });

  it('keeps a late event behind all six already-reserved slots', async () => {
    const channelId = channel('seventh');
    const reservations = [];
    for (let index = 0; index < 6; index += 1) {
      reservations.push(await limiter.reserve(channelId));
    }

    expect(reservations[0].slotAt - (await redisNow())).toBeLessThan(100);
    expect(reservations[5].slotAt - reservations[0].slotAt).toBe(2500);

    await sleep(1200);

    const seventh = await limiter.reserve(channelId);
    expect(seventh.slotAt).toBe(reservations[5].slotAt + 500);
    expect(seventh.slotAt - (await redisNow())).toBeGreaterThan(1500);
  });

  it('keeps reservation state isolated between channels', async () => {
    const channelA = channel('isolation-a');
    const channelB = channel('isolation-b');
    await limiter.reserve(channelA);
    await limiter.reserve(channelA);
    const reservationB = await limiter.reserve(channelB);

    expect(reservationB.slotAt - (await redisNow())).toBeLessThan(100);
  });

  it('expires an idle channel key only after its reserved slot and grace', async () => {
    const channelId = channel('idle');
    const key = `discord-webhook:channel:${channelId}`;
    await limiter.reserve(channelId);

    const ttlMs = await redis.pttl(key);
    expect(ttlMs).toBeGreaterThan(1000);
    expect(ttlMs).toBeLessThanOrEqual(1600);

    await sleep(1700);
    expect(await redis.exists(key)).toBe(0);
  });

  it('never sends overdue events faster than the channel interval', async () => {
    const channelId = channel('overdue');
    // Две задачи опоздали к своим слотам (например, воркеры были заняты).
    const overdue = { slotAt: (await redisNow()) - 5000, shift: 0 };

    await expect(
      limiter.acquireSendPermit(channelId, overdue),
    ).resolves.toEqual({ status: 'granted' });

    const second = await limiter.acquireSendPermit(channelId, overdue);
    expect(second.status).toBe('wait');
    if (second.status === 'wait') {
      expect(second.delayMs).toBeGreaterThan(400);
      expect(second.delayMs).toBeLessThanOrEqual(500);
    }
  });

  it('pauses the whole channel on 429 and shifts its schedule without gaps', async () => {
    const channelA = channel('429-a');
    const channelB = channel('429-b');
    const first = await limiter.reserve(channelA);
    const second = await limiter.reserve(channelA);
    const third = await limiter.reserve(channelA);
    const reservationB = await limiter.reserve(channelB);

    await expect(limiter.acquireSendPermit(channelA, first)).resolves.toEqual({
      status: 'granted',
    });
    await limiter.pauseChannel(channelA, 2000);

    const secondPermit = await limiter.acquireSendPermit(channelA, second);
    const thirdPermit = await limiter.acquireSendPermit(channelA, third);
    expect(secondPermit.status).toBe('wait');
    expect(thirdPermit.status).toBe('wait');
    if (secondPermit.status === 'wait' && thirdPermit.status === 'wait') {
      // Уже выданные слоты сдвинуты целиком: никто не уходит до конца паузы,
      // а интервал 500 мс между ними сохраняется.
      expect(secondPermit.delayMs).toBeGreaterThan(1900);
      expect(
        thirdPermit.reservation.slotAt - secondPermit.reservation.slotAt,
      ).toBe(500);
    }

    // Новое событие встаёт после сдвинутого хвоста расписания.
    const late = await limiter.reserve(channelA);
    if (thirdPermit.status === 'wait') {
      expect(late.slotAt).toBe(thirdPermit.reservation.slotAt + 500);
    }

    // Другой канал продолжает работать.
    await expect(
      limiter.acquireSendPermit(channelB, reservationB),
    ).resolves.toEqual({ status: 'granted' });
  });

  it('keeps working after Redis loses its script cache', async () => {
    const channelId = channel('noscript');
    await limiter.reserve(channelId);
    await redis.script('FLUSH');

    const reservation = await limiter.reserve(channelId);
    expect(reservation.slotAt).toBeGreaterThan(0);
  });
});
