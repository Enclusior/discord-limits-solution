import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export interface RateLimitReservation {
  delayMs: number;
  reservedAt: number;
}

const RATE_LIMIT_LUA = `
local key = KEYS[1]
local interval_ms = tonumber(ARGV[1])
local now_ms = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])
local next_allowed_at = tonumber(redis.call('GET', key) or '0')
local reservation_at = math.max(now_ms, next_allowed_at)
local delay_ms = reservation_at - now_ms
redis.call('SET', key, reservation_at + interval_ms, 'PX', ttl_ms)
return { delay_ms, reservation_at }
`;

@Injectable()
export class RateLimiterService {
  private readonly scriptShaPromise: Promise<string>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.scriptShaPromise = this.redis
      .script('LOAD', RATE_LIMIT_LUA)
      .then((sha) => String(sha));
  }

  async reserve(
    channelId: string,
    rateLimitKey = channelId,
  ): Promise<RateLimitReservation> {
    const ratePerSecond = this.config.getOrThrow<number>(
      'discord.rateLimitPerSecond',
    );
    const intervalMs = Math.ceil(1000 / ratePerSecond);
    const ttlMs = Math.max(intervalMs * 2, 1000);
    const key = `discord-webhook:ratelimit:${rateLimitKey}`;
    const scriptSha = await this.scriptShaPromise;
    const result = (await this.redis.evalsha(
      scriptSha,
      1,
      key,
      intervalMs,
      Date.now(),
      ttlMs,
    )) as [number, number];

    return {
      delayMs: Number(result[0]),
      reservedAt: Number(result[1]),
    };
  }
}
