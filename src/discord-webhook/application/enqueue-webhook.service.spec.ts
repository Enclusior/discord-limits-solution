import { Queue } from 'bullmq';
import { EnqueueWebhookService } from './enqueue-webhook.service';
import { WEBHOOK_QUEUE } from '../infrastructure/queue/queue.providers';

describe('EnqueueWebhookService', () => {
  it('uses eventId as BullMQ job id for deduplication', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'event-1' });
    const service = new EnqueueWebhookService({ add } as unknown as Queue);

    await service.enqueue({
      eventId: 'event-1',
      channelId: 'channel-a',
      webhookUrl: 'https://discord.com/api/webhooks/id/secret',
      payload: { content: 'hello' },
    });

    expect(add).toHaveBeenCalledWith(
      'deliver-webhook',
      expect.objectContaining({ eventId: 'event-1' }),
      expect.objectContaining({ jobId: 'event-1' }),
    );
    expect(WEBHOOK_QUEUE).toBeDefined();
  });
});
