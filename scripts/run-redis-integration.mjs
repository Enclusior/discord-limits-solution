import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/jest/bin/jest.js',
    'src/discord-webhook/infrastructure/redis/rate-limiter.integration.spec.ts',
    '--runInBand',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RUN_REDIS_INTEGRATION: '1',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
