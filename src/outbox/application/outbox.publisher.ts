import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { DiscordWebhookJob } from '@discord-webhook/domain/discord-webhook-job';
import { toQueueJobId } from '@discord-webhook/domain/queue-job-id';
import { WEBHOOK_QUEUE } from '@discord-webhook/infrastructure/queue/queue.providers';
import { OutboxRecord, OutboxRepository } from './outbox.repository';

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rerunRequested = false;
  private stopped = false;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly config: ConfigService,
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    // Polling - страховка: подбирает события после сбоев и истёкших lease.
    const intervalMs = this.config.getOrThrow<number>('outbox.pollIntervalMs');
    this.timer = setInterval(() => this.trigger(), intervalMs);
    this.trigger();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stopped = true;
    await this.running;
  }

  /**
   * Запускает публикацию сразу после записи события, без ожидания polling.
   * Вызовы во время текущего прохода схлопываются в один повторный проход.
   */
  trigger(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
  }

  private async drain(): Promise<void> {
    do {
      this.rerunRequested = false;
      await this.publishBatch();
    } while (this.rerunRequested && !this.stopped);
  }

  private async publishBatch(): Promise<void> {
    try {
      const batchSize = this.config.getOrThrow<number>('outbox.batchSize');
      const batch = await this.repository.claimBatch(
        batchSize,
        this.config.getOrThrow<number>('outbox.leaseMs'),
      );
      await Promise.all(batch.map((record) => this.publish(record)));
      // Полная пачка - вероятно, есть ещё события: забираем без ожидания.
      if (batch.length === batchSize) this.rerunRequested = true;
    } catch (error) {
      this.logger.error({
        event: 'outbox.publisher.failed',
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  private async publish(record: OutboxRecord): Promise<void> {
    const job: DiscordWebhookJob = {
      eventId: record.event_id,
      channelId: record.channel_id,
      webhookUrl: record.webhook_url,
      payload: record.payload,
      metadata: record.metadata,
      createdAt: new Date(record.created_at).toISOString(),
    };

    try {
      // Повторный add с тем же jobId BullMQ игнорирует, поэтому публикация
      // после сбоя между add и markPublished не создаёт дубль.
      await this.queue.add('deliver-webhook', job, {
        jobId: toQueueJobId(record.event_id),
      });
      await this.repository.markPublished(record.event_id);
      this.logger.log({
        event: 'outbox.event.published',
        eventId: record.event_id,
        attempts: record.attempts,
      });
    } catch (error) {
      await this.repository.markForRetry(
        record.event_id,
        error instanceof Error ? error : new Error('unknown publisher error'),
      );
    }
  }
}
