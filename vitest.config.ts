import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration tests share one database — no parallel files.
    fileParallelism: false,
    testTimeout: 30_000, // argon2 + DB operations
    hookTimeout: 30_000,
  },
});
