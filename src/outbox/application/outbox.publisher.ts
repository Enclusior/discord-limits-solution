import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DiscordWebhookJob } from '@discord-webhook/domain/discord-webhook-job';
import { WEBHOOK_QUEUE } from '@discord-webhook/infrastructure/queue/queue.providers';
import { OutboxRecord, OutboxRepository } from './outbox.repository';

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: NodeJS.Timeout;
  private publishing = false;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly config: ConfigService,
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.getOrThrow<number>('outbox.pollIntervalMs');
    this.timer = setInterval(() => void this.publishBatch(), intervalMs);
    void this.publishBatch();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.publishing)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async publishBatch(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      const batch = await this.repository.claimBatch(
        this.config.getOrThrow<number>('outbox.batchSize'),
        this.config.getOrThrow<number>('outbox.leaseMs'),
      );
      await Promise.all(batch.map((record) => this.publish(record)));
    } catch (error) {
      this.logger.error({
        event: 'outbox.publisher.failed',
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    } finally {
      this.publishing = false;
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
      await this.queue.add('deliver-webhook', job, {
        jobId: this.toQueueJobId(record.event_id),
        removeOnComplete: 1000,
        removeOnFail: false,
      });
      await this.repository.markPublished(record.event_id);
      this.logger.log({
        event: 'outbox.event.published',
        eventId: record.event_id,
        attempts: record.attempts,
      });
    } catch (error) {
      if (this.isDuplicateJobError(error)) {
        await this.repository.markPublished(record.event_id);
        return;
      }
      await this.repository.markForRetry(
        record.event_id,
        error instanceof Error ? error : new Error('unknown publisher error'),
      );
    }
  }

  private isDuplicateJobError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('already exists');
  }

  private toQueueJobId(eventId: string): string {
    if (/^[a-zA-Z0-9_-]+$/.test(eventId)) {
      return eventId;
    }

    const digest = createHash('sha256').update(eventId).digest('hex');
    return `event-${digest}`;
  }
}
