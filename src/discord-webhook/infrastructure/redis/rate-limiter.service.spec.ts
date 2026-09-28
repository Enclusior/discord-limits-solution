import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
  const createService = () => {
    const redis = {
      script: jest.fn().mockResolvedValue('script-sha'),
      evalsha: jest.fn().mockResolvedValue([0, 100000]),
      time: jest.fn().mockResolvedValue(['100', '0']),
    } as unknown as Redis;
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'discord.rateLimitPerSecond') return 2;
        if (key === 'discord.rateLimitCleanupGraceMs') return 1000;
        throw new Error(`Unexpected config key: ${key}`);
      }),
    } as unknown as ConfigService;

    return {
      redis,
      service: new RateLimiterService(redis, config),
    };
  };

  it('passes interval and cleanup grace to the atomic reservation script', async () => {
    const { redis, service } = createService();

    await service.reserve('channel-a');

    expect(redis.evalsha).toHaveBeenCalledWith(
      'script-sha',
      1,
      'discord-webhook:ratelimit:channel-a',
      500,
      1000,
    );
  });

  it('calculates reservation delay using Redis server time', async () => {
    const { redis, service } = createService();
    jest.mocked(redis.time).mockResolvedValue(['100', '500000']);

    await expect(service.getRemainingDelayMs(100101)).resolves.toBe(0);
    await expect(service.getRemainingDelayMs(101000)).resolves.toBe(500);
    expect(redis.time).toHaveBeenCalledTimes(2);
  });
});
