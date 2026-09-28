export type DeliveryResult =
  | {
      type: 'success';
      statusCode: number;
      /** Discord сообщил, что лимит исчерпан: пауза до сброса, чтобы не получить 429. */
      rateLimitResetMs?: number;
    }
  | {
      type: 'rate_limited';
      statusCode: 429;
      retryAfterMs: number;
    }
  | {
      type: 'permanent_failure';
      statusCode: number;
      reason: string;
    }
  | {
      type: 'retryable_failure';
      statusCode: number;
      reason: string;
    };
