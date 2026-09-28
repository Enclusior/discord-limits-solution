import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '@discord-webhook/infrastructure/redis/redis.constants';
import { SlotReservation } from '@discord-webhook/domain/discord-webhook-job';

export type SendPermit =
  | { status: 'granted' }
  | { status: 'wait'; delayMs: number; reservation: SlotReservation };

interface LuaScript {
  source: string;
  sha: string;
}

const defineScript = (source: string): LuaScript => ({
  source,
  sha: createHash('sha1').update(source).digest('hex'),
});

// Состояние канала хранится в одном hash:
//   next    - время следующего свободного слота расписания;
//   blocked - до какого момента канал на паузе после Discord 429;
//   shift   - суммарный сдвиг расписания из-за пауз (двигает уже выданные слоты);
//   last    - время последней фактической отправки в канал.
const REDIS_NOW_MS = `
local redis_time = redis.call('TIME')
local now = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
`;

const RESERVE_SLOT = defineScript(`
${REDIS_NOW_MS}
local interval_ms = tonumber(ARGV[1])
local grace_ms = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[1], 'next', 'blocked', 'shift')
local slot = math.max(now, tonumber(state[1] or '0'), tonumber(state[2] or '0'))
local shift = tonumber(state[3] or '0')
redis.call('HSET', KEYS[1], 'next', slot + interval_ms)
redis.call('PEXPIRE', KEYS[1], slot + interval_ms - now + grace_ms)
return { slot, shift }
`);

const ACQUIRE_SEND_PERMIT = defineScript(`
${REDIS_NOW_MS}
local reserved_slot = tonumber(ARGV[1])
local reserved_shift = tonumber(ARGV[2])
local interval_ms = tonumber(ARGV[3])
local grace_ms = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'blocked', 'shift', 'last')
local blocked = tonumber(state[1] or '0')
local shift = tonumber(state[2] or '0')
local last = tonumber(state[3] or '0')
local slot = reserved_slot + math.max(0, shift - reserved_shift)
local ready_at = math.max(slot, blocked, last + interval_ms)
if ready_at > now then
  return { 0, ready_at - now, slot, shift }
end
redis.call('HSET', KEYS[1], 'last', now)
if redis.call('PTTL', KEYS[1]) < interval_ms + grace_ms then
  redis.call('PEXPIRE', KEYS[1], interval_ms + grace_ms)
end
return { 1, 0, slot, shift }
`);

const PAUSE_CHANNEL = defineScript(`
${REDIS_NOW_MS}
local retry_after_ms = tonumber(ARGV[1])
local grace_ms = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[1], 'next', 'blocked', 'shift')
local next_slot = tonumber(state[1] or '0')
local blocked = tonumber(state[2] or '0')
local shift = tonumber(state[3] or '0')
local new_blocked = math.max(blocked, now + retry_after_ms)
local extension = new_blocked - math.max(now, blocked)
next_slot = math.max(next_slot + extension, new_blocked)
redis.call('HSET', KEYS[1], 'next', next_slot, 'blocked', new_blocked, 'shift', shift + extension)
redis.call('PEXPIRE', KEYS[1], next_slot - now + grace_ms)
return new_blocked
`);

@Injectable()
export class RateLimiterService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  /** Ставит событие в конец расписания канала. */
  async reserve(channelId: string): Promise<SlotReservation> {
    const [slotAt, shift] = (await this.run(RESERVE_SLOT, channelId, [
      this.intervalMs,
      this.cleanupGraceMs,
    ])) as [number, number];

    return { slotAt: Number(slotAt), shift: Number(shift) };
  }

  /**
   * Атомарно разрешает отправку, только если наступил слот события
   * (с учётом сдвига после пауз), канал не на паузе и с прошлой отправки
   * прошёл интервал. Иначе возвращает точную задержку до следующей проверки.
   */
  async acquireSendPermit(
    channelId: string,
    reservation: SlotReservation,
  ): Promise<SendPermit> {
    const [granted, delayMs, slotAt, shift] = (await this.run(
      ACQUIRE_SEND_PERMIT,
      channelId,
      [
        reservation.slotAt,
        reservation.shift,
        this.intervalMs,
        this.cleanupGraceMs,
      ],
    )) as [number, number, number, number];

    if (Number(granted) === 1) {
      return { status: 'granted' };
    }
    return {
      status: 'wait',
      delayMs: Number(delayMs),
      reservation: { slotAt: Number(slotAt), shift: Number(shift) },
    };
  }

  /** Ставит весь канал на паузу и сдвигает на неё всё уже выданное расписание. */
  async pauseChannel(channelId: string, retryAfterMs: number): Promise<void> {
    await this.run(PAUSE_CHANNEL, channelId, [
      retryAfterMs,
      this.cleanupGraceMs,
    ]);
  }

  private async run(
    script: LuaScript,
    channelId: string,
    args: number[],
  ): Promise<unknown> {
    const key = `discord-webhook:channel:${channelId}`;
    try {
      return await this.redis.evalsha(script.sha, 1, key, ...args);
    } catch (error) {
      // После рестарта Redis кэш скриптов пуст: EVAL заново загружает скрипт.
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        return this.redis.eval(script.source, 1, key, ...args);
      }
      throw error;
    }
  }

  private get intervalMs(): number {
    return Math.ceil(
      1000 / this.config.getOrThrow<number>('discord.rateLimitPerSecond'),
    );
  }

  private get cleanupGraceMs(): number {
    return this.config.getOrThrow<number>('discord.rateLimitCleanupGraceMs');
  }
}
