export type DeliveryResult =
  | {
      type: 'success';
      statusCode: number;
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
