import { Inject, Injectable, Logger } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { DiscordWebhookJob } from '@discord-webhook/domain/discord-webhook-job';
import { DiscordResponseClassifier } from '@discord-webhook/infrastructure/discord/discord-response-classifier';
import { WEBHOOK_DLX_QUEUE, WEBHOOK_QUEUE } from './queue.providers';
import { RateLimiterService } from '@discord-webhook/infrastructure/redis/rate-limiter.service';
import { WEBHOOK_TRANSPORT } from '@discord-webhook/infrastructure/discord/webhook-transport';
import type { WebhookTransport } from '@discord-webhook/infrastructure/discord/webhook-transport';
import Redis from 'ioredis';
import {
  REDIS_CLIENT,
  DISCORD_WEBHOOK_QUEUE,
} from '@discord-webhook/infrastructure/redis/redis.constants';

@Injectable()
export class WebhookProcessor {
  private readonly logger = new Logger(WebhookProcessor.name);
  private readonly worker: Worker<DiscordWebhookJob>;

  constructor(
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue<DiscordWebhookJob>,
    @Inject(WEBHOOK_DLX_QUEUE)
    private readonly dlxQueue: Queue,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
    @Inject(REDIS_CLIENT) redis: Redis,
    private readonly limiter: RateLimiterService,
    private readonly classifier: DiscordResponseClassifier,
    private readonly config: ConfigService,
  ) {
    this.worker = new Worker(
      DISCORD_WEBHOOK_QUEUE,
      (job) => this.process(job),
      {
        connection: redis.duplicate(),
        concurrency: config.getOrThrow<number>('discord.workerConcurrency'),
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  private async process(job: Job<DiscordWebhookJob>): Promise<void> {
    const { data } = job;
    const reservation = data.reservedAt
      ? {
          delayMs: await this.limiter.getRemainingDelayMs(data.reservedAt),
          reservedAt: data.reservedAt,
          reservationEpoch: data.reservationEpoch ?? 0,
        }
      : await this.limiter.reserve(data.channelId);

    if (reservation.delayMs > 0) {
      await this.reschedule(
        job,
        reservation.delayMs,
        'channel rate limit',
        false,
        reservation.reservedAt,
        reservation.reservationEpoch,
      );
      return;
    }

    const dispatch = await this.limiter.acquireDispatch(
      data.channelId,
      reservation.reservationEpoch,
    );
    if (dispatch.status !== 'acquired') {
      const nextReservation = await this.limiter.reserve(data.channelId);
      await this.reschedule(
        job,
        nextReservation.delayMs,
        dispatch.status === 'stale'
          ? 'channel reservation invalidated'
          : 'channel dispatch in progress',
        false,
        nextReservation.reservedAt,
        nextReservation.reservationEpoch,
      );
      return;
    }

    const startedAt = Date.now();

    try {
      const response = await this.transport.send(data.webhookUrl, data.payload);
      const result = this.classifier.classify(response);

      if (result.type === 'success') {
        await job.updateData({
          ...data,
          deliveredAt: new Date().toISOString(),
        });
        this.logger.log({
          event: 'discord.webhook.sent',
          eventId: data.eventId,
          channelId: data.channelId,
          jobId: job.id,
          statusCode: result.statusCode,
          discordMessageId:
            typeof response.body === 'object' &&
            response.body !== null &&
            'id' in response.body
              ? response.body.id
              : undefined,
          duration: Date.now() - startedAt,
        });
        return;
      }

      if (result.type === 'rate_limited') {
        await this.limiter.pauseChannel(data.channelId, result.retryAfterMs);
        const nextReservation = await this.limiter.reserve(data.channelId);
        await this.reschedule(
          job,
          nextReservation.delayMs,
          'Discord Retry-After',
          true,
          nextReservation.reservedAt,
          nextReservation.reservationEpoch,
        );
        return;
      }

      if (result.type === 'permanent_failure') {
        await this.deadLetter(job, result.reason, result.statusCode);
        return;
      }

      await this.retryOrDeadLetter(job, result.reason);
    } catch (error) {
      await this.retryOrDeadLetter(
        job,
        error instanceof Error ? error.message : 'Unknown transport error',
      );
    } finally {
      await this.limiter.releaseDispatch(data.channelId, dispatch.token);
    }
  }

  private async reschedule(
    job: Job<DiscordWebhookJob>,
    delayMs: number,
    reason: string,
    countsAsDeliveryAttempt = false,
    reservedAt?: number,
    reservationEpoch?: number,
  ): Promise<void> {
    const deliveryAttempts =
      (job.data.deliveryAttempts ?? 0) + Number(countsAsDeliveryAttempt);
    const scheduledData: DiscordWebhookJob = {
      ...job.data,
      deliveryAttempts,
      reservedAt,
      reservationEpoch,
    };
    await this.queue.add(job.name, scheduledData, {
      jobId: `${job.id ?? 'webhook'}-scheduled-${Date.now()}`,
      delay: Math.max(1, delayMs),
      removeOnComplete: 1000,
      removeOnFail: false,
    });
    this.logger.warn({
      event: 'discord.webhook.retry',
      eventId: job.data.eventId,
      channelId: job.data.channelId,
      jobId: job.id,
      retryAfterMs: delayMs,
      reason,
    });
  }

  private async retryOrDeadLetter(
    job: Job<DiscordWebhookJob>,
    reason: string,
  ): Promise<void> {
    const attempts = (job.data.deliveryAttempts ?? 0) + 1;
    const maxAttempts = this.config.getOrThrow<number>(
      'discord.retryMaxAttempts',
    );

    if (attempts >= maxAttempts) {
      await this.deadLetter(job, reason);
      return;
    }

    const baseDelay = this.config.getOrThrow<number>(
      'discord.retryBaseDelayMs',
    );
    const maxDelay = this.config.getOrThrow<number>('discord.retryMaxDelayMs');
    const exponentialDelay = Math.min(
      maxDelay,
      baseDelay * 2 ** Math.max(0, attempts - 1),
    );
    const jitter = Math.floor(
      Math.random() * Math.max(1, exponentialDelay / 4),
    );
    await this.reschedule(job, exponentialDelay + jitter, reason, true);
  }

  private async deadLetter(
    job: Job<DiscordWebhookJob>,
    reason: string,
    statusCode?: number,
  ): Promise<void> {
    await this.dlxQueue.add('dead-letter-webhook', {
      ...job.data,
      reason,
      statusCode,
      attempts: (job.data.deliveryAttempts ?? 0) + 1,
      firstAttemptAt: job.data.createdAt,
      lastAttemptAt: new Date().toISOString(),
    });
    this.logger.error({
      event: 'discord.webhook.dead_lettered',
      eventId: job.data.eventId,
      channelId: job.data.channelId,
      jobId: job.id,
      statusCode,
      reason,
    });
  }
}
