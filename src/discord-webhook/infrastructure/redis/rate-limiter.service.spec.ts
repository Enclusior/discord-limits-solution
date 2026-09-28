import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
  const createService = () => {
    const redis = {
      evalsha: jest.fn(),
      eval: jest.fn(),
    };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'discord.rateLimitPerSecond') return 2;
        if (key === 'discord.rateLimitCleanupGraceMs') return 1000;
        throw new Error(`Unexpected config key: ${key}`);
      }),
    } as unknown as ConfigService;

    return {
      redis,
      service: new RateLimiterService(redis as unknown as Redis, config),
    };
  };

  it('reserves a slot with the channel interval and cleanup grace', async () => {
    const { redis, service } = createService();
    redis.evalsha.mockResolvedValue([100000, 0]);

    await expect(service.reserve('channel-a')).resolves.toEqual({
      slotAt: 100000,
      shift: 0,
    });
    expect(redis.evalsha).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'discord-webhook:channel:channel-a',
      500,
      1000,
    );
  });

  it('returns the exact wait and the shifted reservation when sending is not allowed', async () => {
    const { redis, service } = createService();
    redis.evalsha.mockResolvedValue([0, 1500, 102000, 2000]);

    await expect(
      service.acquireSendPermit('channel-a', { slotAt: 100000, shift: 0 }),
    ).resolves.toEqual({
      status: 'wait',
      delayMs: 1500,
      reservation: { slotAt: 102000, shift: 2000 },
    });
  });

  it('grants sending when the slot is due', async () => {
    const { redis, service } = createService();
    redis.evalsha.mockResolvedValue([1, 0, 100000, 0]);

    await expect(
      service.acquireSendPermit('channel-a', { slotAt: 100000, shift: 0 }),
    ).resolves.toEqual({ status: 'granted' });
  });

  it('falls back to EVAL when Redis lost the script cache', async () => {
    const { redis, service } = createService();
    redis.evalsha.mockRejectedValue(
      new Error('NOSCRIPT No matching script. Please use EVAL.'),
    );
    redis.eval.mockResolvedValue([100000, 0]);

    await expect(service.reserve('channel-a')).resolves.toEqual({
      slotAt: 100000,
      shift: 0,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('HMGET'),
      1,
      'discord-webhook:channel:channel-a',
      500,
      1000,
    );
  });

  it('does not hide other Redis errors', async () => {
    const { redis, service } = createService();
    redis.evalsha.mockRejectedValue(new Error('Connection is closed.'));

    await expect(service.reserve('channel-a')).rejects.toThrow(
      'Connection is closed.',
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
