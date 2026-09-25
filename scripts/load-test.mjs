const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith('--')) continue;
  const [key, inlineValue] = value.slice(2).split('=');
  args.set(key, inlineValue ?? process.argv[index + 1]);
  if (inlineValue === undefined) index += 1;
}

const baseUrl = args.get('base-url') ?? 'http://localhost:3000';
const count = Number(args.get('count') ?? 500);
const channelId = args.get('channel') ?? 'load-test-channel';
const both = args.get('both') === 'true';
const pollMs = Number(args.get('poll-ms') ?? 1000);

if (!Number.isInteger(count) || count < 1 || count > 1000) {
  throw new Error('--count must be an integer between 1 and 1000');
}

const request = async (path, options) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`);
  }
  return body;
};

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const startedAt = Date.now();
const burstPath = both ? '/demo/burst-both' : '/demo/burst';
const burstBody = both ? { count } : { count, channelId };

console.log(
  JSON.stringify({
    event: 'load_test.started',
    baseUrl,
    count: both ? count * 2 : count,
    channelId: both ? undefined : channelId,
    mode: both ? 'two-channels' : 'one-channel',
  }),
);

const produced = await request(burstPath, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(burstBody),
});
const producedCount = both
  ? produced.channelA.count + produced.channelB.count
  : produced.count;
const enqueueDurationMs = Date.now() - startedAt;

let lastStatus;
for (;;) {
  lastStatus = await request('/demo/queue-status');
  const pending = lastStatus.waiting + lastStatus.active + lastStatus.delayed;
  const elapsedMs = Date.now() - startedAt;

  console.log(
    JSON.stringify({
      event: 'load_test.progress',
      elapsedMs,
      pending,
      ...lastStatus,
    }),
  );

  if (pending === 0) break;
  await wait(pollMs);
}

console.log(
  JSON.stringify({
    event: 'load_test.completed',
    produced: producedCount,
    enqueueDurationMs,
    totalDurationMs: Date.now() - startedAt,
    completed: lastStatus.completed,
    failed: lastStatus.failed,
    dlxWaiting: lastStatus.dlxWaiting,
  }),
);
