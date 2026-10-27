import { fileURLToPath } from 'node:url';
import { assertPureScope, pureSources } from './scripts/nonparser-pure-scope.mjs';

await assertPureScope(fileURLToPath(new URL('.', import.meta.url)));

/** Independent fresh campaign; never restores or writes the parser result cache. */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  coverageAnalysis: 'perTest',
  mutate: pureSources,
  reporters: ['clear-text', 'progress', 'json'],
  concurrency: 2,
  timeoutMS: 2000,
  dryRunTimeoutMinutes: 1,
  thresholds: { high: 100, low: 100, break: 100 },
  tempDirName: '.stryker-pure-tmp',
  cleanTempDir: 'always',
  ignorePatterns: ['reports/**', 'coverage/**', 'dist/**', '.git/**', '.cache/**'],
  jsonReporter: { fileName: 'reports/mutation-pure/mutation.json' },
  vitest: { configFile: 'vitest.nonparser-pure.config.mjs', related: true, pool: 'forks' },
  incremental: false,
};
