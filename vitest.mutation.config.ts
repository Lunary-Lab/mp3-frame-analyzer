import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'tests/byte-reader.test.ts',
      'tests/count-frames.test.ts',
      'tests/count-frames.property.test.ts',
      'tests/frame-header.test.ts',
      'tests/free-format.test.ts',
      'tests/free-format-real.test.ts',
      'tests/assessment-sample.test.ts',
      'tests/fuzz-regressions.test.ts',
      'tests/id3.test.ts',
      'tests/parser-boundaries.test.ts',
      'tests/encoder-frame.test.ts',
    ],
    isolate: true,
    fsModuleCache: false,
    maxWorkers: 1,
  },
});
