import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import {
  DeliveryReceipt,
  DiscordWebhookJob,
} from '@discord-webhook/domain/discord-webhook-job';
import { toQueueJobId } from '@discord-webhook/domain/queue-job-id';
import {
  DiscordHttpResponse,
  DiscordResponseClassifier,
} from '@discord-webhook/infrastructure/discord/discord-response-classifier';
import { WEBHOOK_TRANSPORT } from '@discord-webhook/infrastructure/discord/webhook-transport';
import type { WebhookTransport } from '@discord-webhook/infrastructure/discord/webhook-transport';
import { RateLimiterService } from '@discord-webhook/infrastructure/redis/rate-limiter.service';
import { DISCORD_WEBHOOK_QUEUE } from '@discord-webhook/infrastructure/redis/redis.constants';
import {
  createQueueConnection,
  WEBHOOK_DLX_QUEUE,
  WEBHOOK_QUEUE,
} from './queue.providers';

@Injectable()
export class WebhookProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookProcessor.name);
  private worker?: Worker<DiscordWebhookJob, DeliveryReceipt | undefined>;

  constructor(
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue<DiscordWebhookJob>,
    @Inject(WEBHOOK_DLX_QUEUE) private readonly dlxQueue: Queue,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
    private readonly limiter: RateLimiterService,
    private readonly classifier: DiscordResponseClassifier,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(DISCORD_WEBHOOK_QUEUE, (job) => this.handle(job), {
      connection: createQueueConnection(this.config),
      concurrency: this.config.getOrThrow<number>('discord.workerConcurrency'),
    });
    this.worker.on('error', (error) =>
      this.logger.error({
        event: 'discord.webhook.worker_error',
        reason: error.message,
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async handle(
    job: Job<DiscordWebhookJob>,
  ): Promise<DeliveryReceipt | undefined> {
    const { data } = job;
    const reservation =
      data.reservation ?? (await this.limiter.reserve(data.channelId));
    const permit = await this.limiter.acquireSendPermit(
      data.channelId,
      reservation,
    );

    if (permit.status === 'wait') {
      // Задача не держит worker: ждёт своего слота как delayed job.
      await this.reschedule(job, permit.delayMs, {
        reservation: permit.reservation,
      });
      return undefined;
    }

    let response: DiscordHttpResponse;
    try {
      response = await this.transport.send(data.webhookUrl, data.payload);
    } catch (error) {
      await this.retry(
        job,
        error instanceof Error ? error.message : 'Unknown transport error',
      );
      return undefined;
    }

    const result = this.classifier.classify(response);
    switch (result.type) {
      case 'success':
        return this.markDelivered(job, result.statusCode, response.body);
      case 'rate_limited':
        await this.limiter.pauseChannel(data.channelId, result.retryAfterMs);
        // Слот задачи сдвинут вместе со всем расписанием канала;
        // 429 - сигнал ожидания, попыткой доставки он не считается.
        await this.reschedule(job, result.retryAfterMs, { reservation });
        this.logger.warn({
          event: 'discord.webhook.retry',
          eventId: data.eventId,
          channelId: data.channelId,
          jobId: job.id,
          retryAfterMs: result.retryAfterMs,
          reason: 'Discord Retry-After',
        });
        return undefined;
      case 'permanent_failure':
        await this.deadLetter(
          job,
          result.reason,
          (data.deliveryAttempts ?? 0) + 1,
          result.statusCode,
        );
        return undefined;
      case 'retryable_failure':
        await this.retry(job, result.reason, result.statusCode);
        return undefined;
    }
  }

  private markDelivered(
    job: Job<DiscordWebhookJob>,
    statusCode: number,
    body: unknown,
  ): DeliveryReceipt {
    this.logger.log({
      event: 'discord.webhook.sent',
      eventId: job.data.eventId,
      channelId: job.data.channelId,
      jobId: job.id,
      statusCode,
      discordMessageId:
        typeof body === 'object' && body !== null && 'id' in body
          ? body.id
          : undefined,
    });
    // Возвращаемое значение BullMQ сохраняет атомарно с завершением задачи.
    return { deliveredAt: new Date().toISOString(), statusCode };
  }

  /** Любой ответ, кроме 2xx, 400 и 429, и сетевые ошибки: повтор с backoff. */
  private async retry(
    job: Job<DiscordWebhookJob>,
    reason: string,
    statusCode?: number,
  ): Promise<void> {
    const deliveryAttempts = (job.data.deliveryAttempts ?? 0) + 1;
    const maxAttempts = this.config.getOrThrow<number>(
      'discord.retryMaxAttempts',
    );

    if (maxAttempts > 0 && deliveryAttempts >= maxAttempts) {
      await this.deadLetter(job, reason, deliveryAttempts, statusCode);
      return;
    }

    const delayMs = this.backoffDelayMs(deliveryAttempts);
    // После backoff событие заново встаёт в конец расписания канала.
    await this.reschedule(job, delayMs, {
      deliveryAttempts,
      reservation: undefined,
    });
    this.logger.warn({
      event: 'discord.webhook.retry',
      eventId: job.data.eventId,
      channelId: job.data.channelId,
      jobId: job.id,
      statusCode,
      deliveryAttempts,
      retryAfterMs: delayMs,
      reason,
    });
  }

  private backoffDelayMs(deliveryAttempts: number): number {
    const baseDelay = this.config.getOrThrow<number>(
      'discord.retryBaseDelayMs',
    );
    const maxDelay = this.config.getOrThrow<number>('discord.retryMaxDelayMs');
    const exponentialDelay = Math.min(
      maxDelay,
      baseDelay * 2 ** (deliveryAttempts - 1),
    );
    const jitter = Math.floor(Math.random() * (exponentialDelay / 4));
    return exponentialDelay + jitter;
  }

  private async reschedule(
    job: Job<DiscordWebhookJob>,
    delayMs: number,
    patch: Partial<DiscordWebhookJob>,
  ): Promise<void> {
    const rescheduleCount = (job.data.rescheduleCount ?? 0) + 1;
    const data: DiscordWebhookJob = { ...job.data, ...patch, rescheduleCount };

    // jobId детерминирован: если процесс упадёт после add, повторный запуск
    // этой же задачи не создаст вторую копию.
    await this.queue.add(job.name, data, {
      jobId: toQueueJobId(data.eventId, rescheduleCount),
      delay: Math.max(1, Math.ceil(delayMs)),
    });
  }

  private async deadLetter(
    job: Job<DiscordWebhookJob>,
    reason: string,
    attempts: number,
    statusCode?: number,
  ): Promise<void> {
    await this.dlxQueue.add(
      'dead-letter-webhook',
      {
        ...job.data,
        reason,
        statusCode,
        attempts,
        firstAttemptAt: job.data.createdAt,
        lastAttemptAt: new Date().toISOString(),
      },
      { jobId: toQueueJobId(job.data.eventId) },
    );
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
