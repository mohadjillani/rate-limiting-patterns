import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration suites share one Redis instance and use distinct key
    // prefixes to stay isolated; running the files in parallel would still
    // contend on the same connection limit for no benefit.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
