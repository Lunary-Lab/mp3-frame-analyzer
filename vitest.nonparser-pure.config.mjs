import { defineConfig } from 'vitest/config';
import { pureTests } from './scripts/nonparser-pure-scope.mjs';

export default defineConfig({
  test: {
    include: pureTests,
    environment: 'node',
    isolate: true,
    fsModuleCache: false,
    maxWorkers: 1,
    pool: 'forks',
    testTimeout: 5000,
    hookTimeout: 5000,
    passWithNoTests: false,
  },
});
