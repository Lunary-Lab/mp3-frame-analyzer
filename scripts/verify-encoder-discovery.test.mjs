import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertEncoderDiscovery, ENCODER_TEST_NAMES } from './verify-encoder-discovery.mjs';
const report = () => ({
  testFiles: {
    'tests/free-format-real.test.ts': {
      tests: ENCODER_TEST_NAMES.map((name, index) => ({ name, id: String(index) })),
    },
  },
  files: { 'src/mp3/example.ts': { mutants: [{ coveredBy: ['0', '1', '2', '3', '4'] }] } },
});
test('required encoder coverage is present and active, never tool-dependent skipped success', () => {
  assert.equal(assertEncoderDiscovery(report()), 5);
  assert.throws(() => assertEncoderDiscovery({ testFiles: {} }));
  const skipped = report();
  skipped.testFiles['tests/free-format-real.test.ts'].tests.pop();
  assert.throws(() => assertEncoderDiscovery(skipped));
  const inactive = report();
  inactive.files['src/mp3/example.ts'].mutants[0].coveredBy.pop();
  assert.throws(() => assertEncoderDiscovery(inactive));
});
