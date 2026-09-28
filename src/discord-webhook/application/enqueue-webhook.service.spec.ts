import { EnqueueWebhookService } from './enqueue-webhook.service';
import { OutboxPublisher } from '@outbox/application/outbox.publisher';
import { OutboxRepository } from '@outbox/application/outbox.repository';

describe('EnqueueWebhookService', () => {
  it('writes the event to the durable outbox and publishes it right away', async () => {
    const insertPendingEvent = jest.fn().mockResolvedValue(undefined);
    const trigger = jest.fn();
    const service = new EnqueueWebhookService(
      { insertPendingEvent } as unknown as OutboxRepository,
      { trigger } as unknown as OutboxPublisher,
    );

    await service.enqueue({
      eventId: 'event-1',
      channelId: 'channel-a',
      webhookUrl: 'https://discord.com/api/webhooks/id/secret',
      payload: { content: 'hello' },
    });

    expect(insertPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1' }),
    );
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(insertPendingEvent.mock.invocationCallOrder[0]).toBeLessThan(
      trigger.mock.invocationCallOrder[0],
    );
  });
});
