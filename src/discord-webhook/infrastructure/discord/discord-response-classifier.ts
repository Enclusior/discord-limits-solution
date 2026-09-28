import { Injectable } from '@nestjs/common';
import { DeliveryResult } from '@discord-webhook/domain/delivery-result';

export interface DiscordHttpResponse {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

const DEFAULT_RETRY_AFTER_MS = 1000;

@Injectable()
export class DiscordResponseClassifier {
  classify(response: DiscordHttpResponse): DeliveryResult {
    const { statusCode } = response;

    if (statusCode >= 200 && statusCode < 300) {
      const rateLimitResetMs = this.readExhaustedBucketResetMs(response);
      return rateLimitResetMs === undefined
        ? { type: 'success', statusCode }
        : { type: 'success', statusCode, rateLimitResetMs };
    }

    if (statusCode === 429) {
      return {
        type: 'rate_limited',
        statusCode: 429,
        retryAfterMs: this.readRetryAfterMs(response),
      };
    }

    // 400 - неправильно составленный вебхук: повтор всегда даст ту же ошибку.
    if (statusCode === 400) {
      return {
        type: 'permanent_failure',
        statusCode,
        reason: 'Discord rejected the webhook payload (HTTP 400)',
      };
    }

    return {
      type: 'retryable_failure',
      statusCode,
      reason: `Discord returned HTTP ${statusCode}`,
    };
  }

  /**
   * Если в ответе X-RateLimit-Remaining: 0, следующий запрос до сброса лимита
   * гарантированно получит 429. Возвращает время до сброса (X-RateLimit-Reset-After, секунды).
   */
  private readExhaustedBucketResetMs(
    response: DiscordHttpResponse,
  ): number | undefined {
    if (response.headers['x-ratelimit-remaining'] !== '0') {
      return undefined;
    }
    const seconds = Number(response.headers['x-ratelimit-reset-after']);
    return Number.isFinite(seconds) && seconds > 0
      ? Math.ceil(seconds * 1000)
      : undefined;
  }

  /** Discord отдаёт retry_after (тело) и Retry-After (заголовок) в секундах. */
  private readRetryAfterMs(response: DiscordHttpResponse): number {
    const body = response.body;
    const bodyRetryAfter =
      typeof body === 'object' && body !== null && 'retry_after' in body
        ? body.retry_after
        : undefined;
    const seconds = Number(bodyRetryAfter ?? response.headers['retry-after']);

    if (!Number.isFinite(seconds) || seconds < 0) {
      return DEFAULT_RETRY_AFTER_MS;
    }

    return Math.ceil(seconds * 1000);
  }
}
