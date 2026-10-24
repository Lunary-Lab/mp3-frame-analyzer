import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    benchmark: { include: ['bench/**/*.bench.ts'] },
    coverage: {
      provider: 'v8',
      include: ['src/mp3/**/*.ts', 'src/app.ts'],
      exclude: ['src/mp3/errors.ts'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
      reporter: ['text', 'lcov'],
    },
  },
});
