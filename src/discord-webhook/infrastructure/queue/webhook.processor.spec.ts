import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { DiscordWebhookJob } from '@discord-webhook/domain/discord-webhook-job';
import {
  DiscordHttpResponse,
  DiscordResponseClassifier,
} from '@discord-webhook/infrastructure/discord/discord-response-classifier';
import { WebhookTransport } from '@discord-webhook/infrastructure/discord/webhook-transport';
import {
  RateLimiterService,
  SendPermit,
} from '@discord-webhook/infrastructure/redis/rate-limiter.service';
import { WebhookProcessor } from './webhook.processor';

describe('WebhookProcessor', () => {
  const reservation = { slotAt: 100000, shift: 0 };

  beforeAll(() => Logger.overrideLogger(false));

  const createProcessor = (
    options: {
      response?: DiscordHttpResponse | Error;
      permit?: SendPermit;
      retryMaxAttempts?: number;
    } = {},
  ) => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const dlxQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const transport = {
      send: jest.fn(() =>
        options.response instanceof Error
          ? Promise.reject(options.response)
          : Promise.resolve(
              options.response ?? { statusCode: 204, headers: {} },
            ),
      ),
    };
    const limiter = {
      reserve: jest.fn().mockResolvedValue(reservation),
      acquireSendPermit: jest
        .fn()
        .mockResolvedValue(options.permit ?? { status: 'granted' }),
      pauseChannel: jest.fn().mockResolvedValue(undefined),
    };
    const settings: Record<string, number> = {
      'discord.retryMaxAttempts': options.retryMaxAttempts ?? 0,
      'discord.retryBaseDelayMs': 1000,
      'discord.retryMaxDelayMs': 300000,
    };
    const config = {
      getOrThrow: (key: string) => settings[key],
    } as unknown as ConfigService;

    const processor = new WebhookProcessor(
      queue as unknown as Queue<DiscordWebhookJob>,
      dlxQueue as unknown as Queue,
      transport as WebhookTransport,
      limiter as unknown as RateLimiterService,
      new DiscordResponseClassifier(),
      config,
    );

    return { processor, queue, dlxQueue, transport, limiter };
  };

  const createJob = (data: Partial<DiscordWebhookJob> = {}) =>
    ({
      id: 'event-1',
      name: 'deliver-webhook',
      data: {
        eventId: 'event-1',
        channelId: 'channel-a',
        webhookUrl: 'https://discord.com/api/webhooks/1/token',
        payload: { content: 'hello' },
        createdAt: '2026-01-01T00:00:00.000Z',
        ...data,
      },
    }) as unknown as Job<DiscordWebhookJob>;

  it('reserves a slot and delivers when the channel allows it', async () => {
    const { processor, limiter, queue, transport } = createProcessor();

    await expect(processor.handle(createJob())).resolves.toMatchObject({
      statusCode: 204,
    });
    expect(limiter.reserve).toHaveBeenCalledWith('channel-a');
    expect(limiter.acquireSendPermit).toHaveBeenCalledWith(
      'channel-a',
      reservation,
    );
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('pauses the channel in advance when Discord reports an exhausted bucket', async () => {
    const { processor, limiter, queue } = createProcessor({
      response: {
        statusCode: 200,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset-after': '1.5',
        },
      },
    });

    await expect(processor.handle(createJob())).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(limiter.pauseChannel).toHaveBeenCalledWith('channel-a', 1500);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('still completes a delivered job when the advance pause fails', async () => {
    const { processor, limiter } = createProcessor({
      response: {
        statusCode: 200,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset-after': '1.5',
        },
      },
    });
    limiter.pauseChannel.mockRejectedValue(new Error('Connection is closed.'));

    await expect(processor.handle(createJob())).resolves.toMatchObject({
      statusCode: 200,
    });
  });

  it('reuses an existing reservation instead of taking a new slot', async () => {
    const { processor, limiter } = createProcessor();

    await processor.handle(createJob({ reservation }));

    expect(limiter.reserve).not.toHaveBeenCalled();
  });

  it('waits for its slot as a delayed job without calling Discord', async () => {
    const shifted = { slotAt: 102000, shift: 2000 };
    const { processor, queue, transport } = createProcessor({
      permit: { status: 'wait', delayMs: 1500, reservation: shifted },
    });

    await processor.handle(createJob());

    expect(transport.send).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'deliver-webhook',
      expect.objectContaining({ reservation: shifted, rescheduleCount: 1 }),
      { jobId: 'event-1--r1', delay: 1500 },
    );
  });

  it('sends HTTP 400 straight to DLX without retrying', async () => {
    const { processor, queue, dlxQueue } = createProcessor({
      response: { statusCode: 400, headers: {} },
    });

    await processor.handle(createJob());

    expect(queue.add).not.toHaveBeenCalled();
    expect(dlxQueue.add).toHaveBeenCalledWith(
      'dead-letter-webhook',
      expect.objectContaining({ eventId: 'event-1', statusCode: 400 }),
      { jobId: 'event-1' },
    );
  });

  it('pauses the whole channel on 429 without spending a delivery attempt', async () => {
    const { processor, queue, limiter, dlxQueue } = createProcessor({
      response: {
        statusCode: 429,
        headers: {},
        body: { retry_after: 2.5 },
      },
    });

    await processor.handle(createJob({ reservation, deliveryAttempts: 3 }));

    expect(limiter.pauseChannel).toHaveBeenCalledWith('channel-a', 2500);
    expect(queue.add).toHaveBeenCalledWith(
      'deliver-webhook',
      expect.objectContaining({ reservation, deliveryAttempts: 3 }),
      expect.objectContaining({ delay: 2500 }),
    );
    expect(dlxQueue.add).not.toHaveBeenCalled();
  });

  it.each([401, 404, 500])(
    'retries HTTP %i with backoff and a fresh slot',
    async (statusCode) => {
      const { processor, queue, dlxQueue } = createProcessor({
        response: { statusCode, headers: {} },
      });

      await processor.handle(createJob({ reservation }));

      const [, data, options] = queue.add.mock.calls[0] as [
        string,
        DiscordWebhookJob,
        { delay: number },
      ];
      expect(data.deliveryAttempts).toBe(1);
      expect(data.reservation).toBeUndefined();
      expect(options.delay).toBeGreaterThanOrEqual(1000);
      expect(options.delay).toBeLessThan(1250);
      expect(dlxQueue.add).not.toHaveBeenCalled();
    },
  );

  it('retries network errors', async () => {
    const { processor, queue } = createProcessor({
      response: new Error('Discord transport failed: ETIMEDOUT'),
    });

    await processor.handle(createJob());

    expect(queue.add).toHaveBeenCalledWith(
      'deliver-webhook',
      expect.objectContaining({ deliveryAttempts: 1 }),
      expect.anything(),
    );
  });

  it('keeps retrying without a limit and caps the backoff delay', async () => {
    const { processor, queue, dlxQueue } = createProcessor({
      response: { statusCode: 503, headers: {} },
    });

    await processor.handle(createJob({ deliveryAttempts: 50 }));

    const [, , options] = queue.add.mock.calls[0] as [
      string,
      DiscordWebhookJob,
      { delay: number },
    ];
    expect(options.delay).toBeLessThan(300000 * 1.25);
    expect(dlxQueue.add).not.toHaveBeenCalled();
  });

  it('moves to DLX after the optional attempt limit', async () => {
    const { processor, queue, dlxQueue } = createProcessor({
      response: { statusCode: 503, headers: {} },
      retryMaxAttempts: 3,
    });

    await processor.handle(createJob({ deliveryAttempts: 2 }));

    expect(queue.add).not.toHaveBeenCalled();
    expect(dlxQueue.add).toHaveBeenCalledWith(
      'dead-letter-webhook',
      expect.objectContaining({ attempts: 3, statusCode: 503 }),
      { jobId: 'event-1' },
    );
  });
});
