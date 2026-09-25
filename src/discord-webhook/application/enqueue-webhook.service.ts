import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import {
  DiscordWebhookJob,
  EnqueueWebhookInput,
} from '@discord-webhook/domain/discord-webhook-job';
import { WEBHOOK_QUEUE } from '@discord-webhook/infrastructure/queue/queue.providers';

@Injectable()
export class EnqueueWebhookService {
  constructor(@Inject(WEBHOOK_QUEUE) private readonly queue: Queue) {}

  async enqueue(input: EnqueueWebhookInput): Promise<{ jobId: string }> {
    const job: DiscordWebhookJob = {
      ...input,
      createdAt: new Date().toISOString(),
    };
    const queuedJob = await this.queue.add('deliver-webhook', job, {
      jobId: this.toQueueJobId(input.eventId),
      removeOnComplete: 1000,
      removeOnFail: false,
    });

    return { jobId: queuedJob.id ?? input.eventId };
  }

  private toQueueJobId(eventId: string): string {
    if (/^[a-zA-Z0-9_-]+$/.test(eventId)) {
      return eventId;
    }

    const digest = createHash('sha256').update(eventId).digest('hex');
    return `event-${digest}`;
  }
}
