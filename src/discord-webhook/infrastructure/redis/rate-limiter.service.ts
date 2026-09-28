import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '@discord-webhook/infrastructure/redis/redis.constants';

export interface RateLimitReservation {
  delayMs: number;
  reservedAt: number;
  reservationEpoch: number;
}

export type DispatchAcquisition =
  | { status: 'acquired'; token: string }
  | { status: 'blocked' | 'stale'; delayMs: number };

const RATE_LIMIT_LUA = `
local key = KEYS[1]
local epoch_key = key .. ':epoch'
local blocked_key = key .. ':blocked-until'
local interval_ms = tonumber(ARGV[1])
local cleanup_grace_ms = tonumber(ARGV[2])
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local next_allowed_at = tonumber(redis.call('GET', key) or '0')
local blocked_until = tonumber(redis.call('GET', blocked_key) or '0')
local reservation_at = math.max(now_ms, next_allowed_at, blocked_until)
local next_slot_at = reservation_at + interval_ms
local delay_ms = reservation_at - now_ms
local ttl_ms = next_slot_at - now_ms + cleanup_grace_ms
redis.call('SET', key, next_slot_at, 'PX', ttl_ms)
local epoch = tonumber(redis.call('GET', epoch_key) or '0')
redis.call('SET', epoch_key, epoch, 'PX', ttl_ms)
return { delay_ms, reservation_at, epoch }
`;

const PAUSE_CHANNEL_LUA = `
local key = KEYS[1]
local epoch_key = key .. ':epoch'
local blocked_key = key .. ':blocked-until'
local retry_after_ms = tonumber(ARGV[1])
local cleanup_grace_ms = tonumber(ARGV[2])
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local blocked_until = math.max(
  tonumber(redis.call('GET', blocked_key) or '0'),
  now_ms + retry_after_ms
)
local epoch = redis.call('INCR', epoch_key)
local next_allowed_at = math.max(
  tonumber(redis.call('GET', key) or '0'),
  blocked_until
)
local ttl_ms = next_allowed_at - now_ms + cleanup_grace_ms
redis.call('SET', blocked_key, blocked_until, 'PX', ttl_ms)
redis.call('SET', key, next_allowed_at, 'PX', ttl_ms)
redis.call('PEXPIRE', epoch_key, ttl_ms)
return { blocked_until, epoch }
`;

const ACQUIRE_DISPATCH_LUA = `
local schedule_key = KEYS[1]
local epoch_key = schedule_key .. ':epoch'
local blocked_key = schedule_key .. ':blocked-until'
local lock_key = schedule_key .. ':dispatch-lock'
local expected_epoch = tonumber(ARGV[1])
local token = ARGV[2]
local lock_ttl_ms = tonumber(ARGV[3])
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local current_epoch = tonumber(redis.call('GET', epoch_key) or '0')
if current_epoch ~= expected_epoch then
  return { 'stale', 0 }
end
local blocked_until = tonumber(redis.call('GET', blocked_key) or '0')
if blocked_until > now_ms then
  return { 'blocked', blocked_until - now_ms }
end
local lock_ttl = redis.call('PTTL', lock_key)
if lock_ttl > 0 then
  return { 'blocked', lock_ttl }
end
local acquired = redis.call('SET', lock_key, token, 'PX', lock_ttl_ms, 'NX')
if acquired then
  return { 'acquired', token }
end
return { 'blocked', math.max(1, redis.call('PTTL', lock_key)) }
`;

const RELEASE_DISPATCH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class RateLimiterService {
  private readonly scriptShaPromises: Promise<string>[];

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.scriptShaPromises = [
      RATE_LIMIT_LUA,
      PAUSE_CHANNEL_LUA,
      ACQUIRE_DISPATCH_LUA,
      RELEASE_DISPATCH_LUA,
    ].map((script) =>
      this.redis.script('LOAD', script).then((sha) => String(sha)),
    );
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
    const scriptSha = await this.scriptShaPromises[0];
    const result = (await this.redis.evalsha(
      scriptSha,
      1,
      key,
      intervalMs,
      cleanupGraceMs,
    )) as [number, number, number];

    return {
      delayMs: Number(result[0]),
      reservedAt: Number(result[1]),
      reservationEpoch: Number(result[2]),
    };
  }

  async pauseChannel(
    channelId: string,
    retryAfterMs: number,
  ): Promise<{ blockedUntil: number; reservationEpoch: number }> {
    const cleanupGraceMs = this.config.getOrThrow<number>(
      'discord.rateLimitCleanupGraceMs',
    );
    const key = this.getChannelKey(channelId);
    const scriptSha = await this.scriptShaPromises[1];
    const result = (await this.redis.evalsha(
      scriptSha,
      1,
      key,
      retryAfterMs,
      cleanupGraceMs,
    )) as [number, number];

    return {
      blockedUntil: Number(result[0]),
      reservationEpoch: Number(result[1]),
    };
  }

  async acquireDispatch(
    channelId: string,
    reservationEpoch: number,
  ): Promise<DispatchAcquisition> {
    const lockTtlMs = this.config.getOrThrow<number>(
      'discord.dispatchLockTtlMs',
    );
    const scriptSha = await this.scriptShaPromises[2];
    const token = randomUUID();
    const result = (await this.redis.evalsha(
      scriptSha,
      1,
      this.getChannelKey(channelId),
      reservationEpoch,
      token,
      lockTtlMs,
    )) as [string, string | number];

    if (result[0] === 'acquired') {
      return { status: 'acquired', token: String(result[1]) };
    }
    if (result[0] === 'stale') {
      return { status: 'stale', delayMs: Number(result[1]) };
    }
    return { status: 'blocked', delayMs: Number(result[1]) };
  }

  async releaseDispatch(channelId: string, token: string): Promise<void> {
    const scriptSha = await this.scriptShaPromises[3];
    await this.redis.evalsha(
      scriptSha,
      1,
      `${this.getChannelKey(channelId)}:dispatch-lock`,
      token,
    );
  }

  async getRemainingDelayMs(reservedAt: number): Promise<number> {
    const [seconds, microseconds] = await this.redis.time();
    const redisNowMs =
      Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
    return Math.max(0, reservedAt - redisNowMs);
  }

  private getChannelKey(channelId: string): string {
    return `discord-webhook:ratelimit:${channelId}`;
  }
}
