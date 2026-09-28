import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createValidationPipe } from '@config/validation-pipe';
import { EnqueueWebhookService } from '@discord-webhook/application/enqueue-webhook.service';
import { QueueStatsService } from '@discord-webhook/application/queue-stats.service';
import { DemoController } from '@demo/demo.controller';

describe('Demo API (e2e)', () => {
  let app: INestApplication<App>;
  const enqueue = jest.fn(({ eventId }: { eventId: string }) =>
    Promise.resolve({ eventId }),
  );

  const validEvent = {
    eventId: 'user-123-registered',
    channelId: 'new-users',
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    payload: { embeds: [{ title: 'New user' }] },
  };

  beforeEach(async () => {
    enqueue.mockClear();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [
        { provide: EnqueueWebhookService, useValue: { enqueue } },
        { provide: QueueStatsService, useValue: {} },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid webhook event', async () => {
    await request(app.getHttpServer())
      .post('/demo/webhook')
      .send(validEvent)
      .expect(201)
      .expect({ eventId: 'user-123-registered' });

    expect(enqueue).toHaveBeenCalledWith(validEvent);
  });

  it('rejects a non-Discord webhook URL', async () => {
    await request(app.getHttpServer())
      .post('/demo/webhook')
      .send({ ...validEvent, webhookUrl: 'http://169.254.169.254/latest' })
      .expect(400);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects an event without required fields', async () => {
    await request(app.getHttpServer())
      .post('/demo/webhook')
      .send({ eventId: 'only-id' })
      .expect(400);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('limits burst size', async () => {
    await request(app.getHttpServer())
      .post('/demo/burst')
      .send({ count: 5000 })
      .expect(400);
  });
});
