import { DiscordResponseClassifier } from './discord-response-classifier';

describe('DiscordResponseClassifier', () => {
  const classifier = new DiscordResponseClassifier();

  it('classifies 2xx as success', () => {
    expect(classifier.classify({ statusCode: 204, headers: {} })).toEqual({
      type: 'success',
      statusCode: 204,
    });
  });

  it('reports an exhausted Discord bucket on a successful response', () => {
    expect(
      classifier.classify({
        statusCode: 200,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset-after': '1.5',
        },
      }),
    ).toEqual({ type: 'success', statusCode: 200, rateLimitResetMs: 1500 });
  });

  it('does not pause while the Discord bucket still has requests left', () => {
    expect(
      classifier.classify({
        statusCode: 200,
        headers: {
          'x-ratelimit-remaining': '1',
          'x-ratelimit-reset-after': '1.5',
        },
      }),
    ).toEqual({ type: 'success', statusCode: 200 });
  });

  it('prefers body retry_after (seconds) for 429', () => {
    expect(
      classifier.classify({
        statusCode: 429,
        headers: { 'retry-after': '1' },
        body: { retry_after: 1.73 },
      }),
    ).toEqual({ type: 'rate_limited', statusCode: 429, retryAfterMs: 1730 });
  });

  it('treats long Retry-After values as seconds too', () => {
    expect(
      classifier.classify({
        statusCode: 429,
        headers: { 'retry-after': '120' },
      }),
    ).toMatchObject({ type: 'rate_limited', retryAfterMs: 120000 });
  });

  it('falls back to one second when 429 has no usable Retry-After', () => {
    expect(classifier.classify({ statusCode: 429, headers: {} })).toMatchObject(
      { type: 'rate_limited', retryAfterMs: 1000 },
    );
  });

  it('sends only 400 to DLX', () => {
    expect(classifier.classify({ statusCode: 400, headers: {} })).toMatchObject(
      { type: 'permanent_failure', statusCode: 400 },
    );
  });

  it.each([401, 403, 404, 413, 500, 502, 503])(
    'retries HTTP %i',
    (statusCode) => {
      expect(classifier.classify({ statusCode, headers: {} })).toMatchObject({
        type: 'retryable_failure',
        statusCode,
      });
    },
  );
});
