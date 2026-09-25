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
const sendSummary = args.get('send-summary') !== 'false';
const webhookUrl = args.get('webhook-url');
const runId = `load-${Date.now()}`;

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
const burstBody = both
  ? { count, runId }
  : { count, channelId, runId, webhookUrl };

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
  lastStatus = await request(`/demo/queue-status?runId=${runId}`);
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

  if (
    pending === 0 &&
    lastStatus.completed + lastStatus.failed >= producedCount
  ) {
    break;
  }
  await wait(pollMs);
}

const totalDurationMs = Date.now() - startedAt;
const throughput = totalDurationMs
  ? Math.round((producedCount / totalDurationMs) * 1000 * 100) / 100
  : 0;
const summary = {
  produced: producedCount,
  completed: lastStatus.completed,
  failed: lastStatus.failed,
  dlxWaiting: lastStatus.dlxWaiting,
  pending: lastStatus.pending,
  enqueueDurationMs,
  totalDurationMs,
  throughputPerSecond: throughput,
  averageDeliveryMs: lastStatus.averageDeliveryMs,
};

console.log('\n=== LOAD TEST SUMMARY ===');
console.table(summary);
console.log(
  JSON.stringify({ event: 'load_test.completed', runId, ...summary }),
);

if (sendSummary) {
  await request('/demo/load-summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      summary: Object.entries(summary)
        .map(([key, value]) => `${key}: ${value ?? 'n/a'}`)
        .join('\n'),
    }),
  });
  console.log('Summary webhook queued to DISCORD_WEBHOOK_A.');
}
