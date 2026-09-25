import { Injectable } from '@nestjs/common';
import { DeliveryResult } from '@discord-webhook/domain/delivery-result';

export interface DiscordHttpResponse {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

@Injectable()
export class DiscordResponseClassifier {
  classify(response: DiscordHttpResponse): DeliveryResult {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { type: 'success', statusCode: response.statusCode };
    }

    if (response.statusCode === 429) {
      const retryAfterMs = this.readRetryAfterMs(response);

      return {
        type: 'rate_limited',
        statusCode: 429,
        retryAfterMs,
        rateLimitKey:
          response.headers['x-ratelimit-bucket'] ?? 'discord-channel',
      };
    }

    if ([400, 401, 403, 404].includes(response.statusCode)) {
      return {
        type: 'permanent_failure',
        statusCode: response.statusCode,
        reason: `Discord returned permanent HTTP ${response.statusCode}`,
      };
    }

    if (response.statusCode >= 500 && response.statusCode < 600) {
      return {
        type: 'retryable_failure',
        reason: `Discord returned retryable HTTP ${response.statusCode}`,
      };
    }

    return {
      type: 'permanent_failure',
      statusCode: response.statusCode,
      reason: `Discord returned unexpected HTTP ${response.statusCode}`,
    };
  }

  private readRetryAfterMs(response: DiscordHttpResponse): number {
    const body = response.body;
    const bodyRetryAfter =
      typeof body === 'object' && body !== null && 'retry_after' in body
        ? body.retry_after
        : undefined;
    const headerRetryAfter = response.headers['retry-after'];
    const retryAfter = bodyRetryAfter ?? headerRetryAfter;
    const retryAfterNumber = Number(retryAfter);

    if (!Number.isFinite(retryAfterNumber) || retryAfterNumber < 0) {
      return 1000;
    }

    return retryAfterNumber < 100 ? retryAfterNumber * 1000 : retryAfterNumber;
  }
}
