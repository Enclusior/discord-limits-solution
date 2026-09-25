import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EnqueueWebhookService } from './application/enqueue-webhook.service';
import { DiscordResponseClassifier } from './infrastructure/discord/discord-response-classifier';
import { DiscordWebhookTransport } from './infrastructure/discord/discord-webhook.transport';
import { WEBHOOK_TRANSPORT } from './infrastructure/discord/webhook-transport';
import { queueProviders } from './infrastructure/queue/queue.providers';
import { WebhookProcessor } from './infrastructure/queue/webhook.processor';
import { RateLimiterService } from './infrastructure/redis/rate-limiter.service';
import { redisProvider } from './infrastructure/redis/redis.provider';

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
  exports: [EnqueueWebhookService],
})
export class DiscordWebhookModule {}
