import { defineConfig } from 'vitest/config';

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
