import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    execArgv: ['--expose-gc'],
    testTimeout: 15_000,
    benchmark: { include: ['bench/**/*.bench.ts'] },
    coverage: {
      provider: 'v8',
      include: [
        'src/mp3/**/*.ts',
        'src/app.ts',
        'src/logging.ts',
        'src/upload.ts',
        'src/error-response.ts',
        'src/client-error.ts',
        'src/shutdown.ts',
        'src/server-config.ts',
      ],
      thresholds: {
        lines: 95,
        functions: 100,
        branches: 95,
        statements: 95,
        'src/mp3/**/*.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
      reporter: ['text', 'lcov'],
    },
  },
});
