import { EnqueueWebhookService } from './enqueue-webhook.service';
import { OutboxRepository } from '@outbox/application/outbox.repository';

describe('EnqueueWebhookService', () => {
  it('writes the event to the durable outbox', async () => {
    const insertPendingEvent = jest.fn().mockResolvedValue(undefined);
    const service = new EnqueueWebhookService({
      insertPendingEvent,
    } as unknown as OutboxRepository);

    await service.enqueue({
      eventId: 'event-1',
      channelId: 'channel-a',
      webhookUrl: 'https://discord.com/api/webhooks/id/secret',
      payload: { content: 'hello' },
    });

    expect(insertPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1' }),
    );
  });
});
