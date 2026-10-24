import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import the contracts source directly, so they never run against a stale build.
const alias = {
  '@elevate/contracts': fileURLToPath(
    new URL('../../packages/contracts/src/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/setup/global-setup.ts'],
          // One Postgres and one Redis are shared by all files; files run one at a time and
          // each starts from a clean state. Concurrency is exercised *inside* the tests.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
