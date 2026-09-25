import { DiscordResponseClassifier } from './discord-response-classifier';

describe('DiscordResponseClassifier', () => {
  const classifier = new DiscordResponseClassifier();

  it('classifies 2xx as success', () => {
    expect(classifier.classify({ statusCode: 204, headers: {} })).toEqual({
      type: 'success',
      statusCode: 204,
    });
  });

  it('uses body retry_after for 429', () => {
    expect(
      classifier.classify({
        statusCode: 429,
        headers: { 'retry-after': '0.5' },
        body: { retry_after: 1.73 },
      }),
    ).toEqual({
      type: 'rate_limited',
      statusCode: 429,
      retryAfterMs: 1730,
      rateLimitKey: 'discord-channel',
    });
  });

  it('does not classify 400 as retryable', () => {
    expect(classifier.classify({ statusCode: 400, headers: {} })).toMatchObject(
      { type: 'permanent_failure', statusCode: 400 },
    );
  });

  it('classifies 5xx as retryable', () => {
    expect(classifier.classify({ statusCode: 503, headers: {} })).toMatchObject(
      { type: 'retryable_failure' },
    );
  });
});
