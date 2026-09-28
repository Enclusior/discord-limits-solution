import { Injectable } from '@nestjs/common';
import {
  DiscordWebhookJob,
  EnqueueWebhookInput,
} from '@discord-webhook/domain/discord-webhook-job';
import { OutboxPublisher } from '@outbox/application/outbox.publisher';
import { OutboxRepository } from '@outbox/application/outbox.repository';

@Injectable()
export class EnqueueWebhookService {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly publisher: OutboxPublisher,
  ) {}

  async enqueue(input: EnqueueWebhookInput): Promise<{ eventId: string }> {
    const job: DiscordWebhookJob = {
      ...input,
      createdAt: new Date().toISOString(),
    };
    await this.outbox.insertPendingEvent(job);
    // Событие уже durable в PostgreSQL; публикуем в очередь сразу,
    // не дожидаясь следующего polling-прохода.
    this.publisher.trigger();
    return { eventId: input.eventId };
  }
}
