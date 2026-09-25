import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
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
      jobId: input.eventId,
      removeOnComplete: 1000,
      removeOnFail: false,
    });

    return { jobId: queuedJob.id ?? input.eventId };
  }
}
