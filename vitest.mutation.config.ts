import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
import MutationFastFirstSequencer from './scripts/mutation-fast-first-sequencer.mjs';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/mp3/**/*.test.ts'],
    passWithNoTests: false,
    isolate: true,
    fsModuleCache: false,
    maxWorkers: 1,
    sequence: { sequencer: MutationFastFirstSequencer },
  },
});
