import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The in-memory SurrealDB engine is a native module, so run test files in
    // separate processes rather than worker threads.
    pool: 'forks',
  },
});
