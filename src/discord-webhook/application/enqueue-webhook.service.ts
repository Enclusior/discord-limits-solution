import { Injectable } from '@nestjs/common';
import {
  DiscordWebhookJob,
  EnqueueWebhookInput,
} from '@discord-webhook/domain/discord-webhook-job';
import { OutboxRepository } from '@outbox/application/outbox.repository';

@Injectable()
export class EnqueueWebhookService {
  constructor(private readonly outbox: OutboxRepository) {}

  async enqueue(input: EnqueueWebhookInput): Promise<{ eventId: string }> {
    const job: DiscordWebhookJob = {
      ...input,
      createdAt: new Date().toISOString(),
    };
    await this.outbox.insertPendingEvent(job);
    return { eventId: input.eventId };
  }
}
