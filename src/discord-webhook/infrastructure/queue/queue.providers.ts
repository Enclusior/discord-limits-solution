import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Queue } from 'bullmq';
import {
  DISCORD_WEBHOOK_DLX_QUEUE,
  DISCORD_WEBHOOK_QUEUE,
} from '@discord-webhook/infrastructure/redis/redis.constants';

export const WEBHOOK_QUEUE = Symbol('WEBHOOK_QUEUE');
export const WEBHOOK_DLX_QUEUE = Symbol('WEBHOOK_DLX_QUEUE');

// Параметры, а не готовый клиент: так BullMQ сам закрывает соединение в close().
export const createQueueConnection = (
  config: ConfigService,
): ConnectionOptions => ({
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
        connection: createQueueConnection(config),
        defaultJobOptions: {
          // Повторы на случай сбоя инфраструктуры (Redis) внутри обработчика.
          // Ответы Discord обрабатываются явно и сюда не попадают.
          attempts: 15,
          backoff: { type: 'exponential', delay: 1000 },
          // Завершённые задачи храним час: это с большим запасом дольше lease
          // outbox (30 с), поэтому повторная публикация с тем же jobId не создаст
          // дубль, а Redis не копит payload завершённых задач.
          removeOnComplete: { age: 60 * 60 },
          removeOnFail: false,
        },
      }),
  },
  {
    provide: WEBHOOK_DLX_QUEUE,
    inject: [ConfigService],
    useFactory: (config: ConfigService): Queue =>
      new Queue(DISCORD_WEBHOOK_DLX_QUEUE, {
        connection: createQueueConnection(config),
      }),
  },
];
