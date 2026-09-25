import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  DISCORD_WEBHOOK_DLX_QUEUE,
  DISCORD_WEBHOOK_QUEUE,
  REDIS_CLIENT,
} from '../redis/redis.constants';

export const WEBHOOK_QUEUE = Symbol('WEBHOOK_QUEUE');
export const WEBHOOK_DLX_QUEUE = Symbol('WEBHOOK_DLX_QUEUE');

const createConnection = (config: ConfigService): Redis =>
  new Redis({
    host: config.getOrThrow<string>('redis.host'),
    port: config.getOrThrow<number>('redis.port'),
    password: config.get<string>('redis.password'),
    maxRetriesPerRequest: null,
  });

export const queueProviders: Provider[] = [
  {
    provide: WEBHOOK_QUEUE,
    inject: [ConfigService],
    useFactory: (config: ConfigService): Queue =>
      new Queue(DISCORD_WEBHOOK_QUEUE, {
        connection: createConnection(config),
      }),
  },
  {
    provide: WEBHOOK_DLX_QUEUE,
    inject: [ConfigService],
    useFactory: (config: ConfigService): Queue =>
      new Queue(DISCORD_WEBHOOK_DLX_QUEUE, {
        connection: createConnection(config),
      }),
  },
];

export const queueTokens = [WEBHOOK_QUEUE, WEBHOOK_DLX_QUEUE, REDIS_CLIENT];
