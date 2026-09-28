import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '@discord-webhook/infrastructure/redis/redis.constants';

export interface RateLimitReservation {
  delayMs: number;
  reservedAt: number;
}

const RATE_LIMIT_LUA = `
local key = KEYS[1]
local interval_ms = tonumber(ARGV[1])
local cleanup_grace_ms = tonumber(ARGV[2])
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local next_allowed_at = tonumber(redis.call('GET', key) or '0')
local reservation_at = math.max(now_ms, next_allowed_at)
local next_slot_at = reservation_at + interval_ms
local delay_ms = reservation_at - now_ms
local ttl_ms = next_slot_at - now_ms + cleanup_grace_ms
redis.call('SET', key, next_slot_at, 'PX', ttl_ms)
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
    const cleanupGraceMs = this.config.getOrThrow<number>(
      'discord.rateLimitCleanupGraceMs',
    );
    const key = `discord-webhook:ratelimit:${rateLimitKey}`;
    const scriptSha = await this.scriptShaPromise;
    const result = (await this.redis.evalsha(
      scriptSha,
      1,
      key,
      intervalMs,
      cleanupGraceMs,
    )) as [number, number];

    return {
      delayMs: Number(result[0]),
      reservedAt: Number(result[1]),
    };
  }

  async getRemainingDelayMs(reservedAt: number): Promise<number> {
    const [seconds, microseconds] = await this.redis.time();
    const redisNowMs =
      Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
    return Math.max(0, reservedAt - redisNowMs);
  }
}
