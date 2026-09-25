import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EnqueueWebhookService } from './application/enqueue-webhook.service';
import { DiscordResponseClassifier } from './infrastructure/discord/discord-response-classifier';
import { DiscordWebhookTransport } from './infrastructure/discord/discord-webhook.transport';
import { WEBHOOK_TRANSPORT } from './infrastructure/discord/webhook-transport';
import { queueProviders } from './infrastructure/queue/queue.providers';
import { WebhookProcessor } from './infrastructure/queue/webhook.processor';
import { RateLimiterService } from './infrastructure/redis/rate-limiter.service';
import { redisProvider } from './infrastructure/redis/redis.provider';
import {
  WEBHOOK_DLX_QUEUE,
  WEBHOOK_QUEUE,
} from './infrastructure/queue/queue.providers';
import { REDIS_CLIENT } from './infrastructure/redis/redis.constants';
import type Redis from 'ioredis';
import type { Queue } from 'bullmq';

@Module({
  imports: [ConfigModule],
  providers: [
    redisProvider,
    ...queueProviders,
    DiscordResponseClassifier,
    DiscordWebhookTransport,
    {
      provide: WEBHOOK_TRANSPORT,
      useExisting: DiscordWebhookTransport,
    },
    RateLimiterService,
    WebhookProcessor,
    EnqueueWebhookService,
  ],
  exports: [
    EnqueueWebhookService,
    WEBHOOK_QUEUE,
    WEBHOOK_DLX_QUEUE,
    REDIS_CLIENT,
  ],
})
export class DiscordWebhookModule implements OnModuleDestroy {
  constructor(
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue,
    @Inject(WEBHOOK_DLX_QUEUE) private readonly dlxQueue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.queue.close(), this.dlxQueue.close()]);
    await this.redis.quit();
  }
}
