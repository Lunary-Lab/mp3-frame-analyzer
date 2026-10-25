import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isMain } from './release-utils.mjs';

export const ENCODER_TEST_NAMES = Object.freeze(
  [
    '44100-1-400-false',
    '48000-2-320-false',
    '32000-1-400-true',
    '48000-2-128-false',
    '32000-2-192-false',
  ].map((name) => `counts fixed genuine LAME free-format ${name}`),
);

export function assertEncoderDiscovery(report) {
  const file = report.testFiles?.['tests/free-format-real.test.ts'];
  assert.ok(Array.isArray(file?.tests), 'Genuine encoder mutation suite is missing');
  assert.deepEqual(
    file.tests.map((test) => test.name).sort(),
    [...ENCODER_TEST_NAMES].sort(),
    'Encoder tests missing or skipped',
  );
  const active = new Set(
    Object.values(report.files ?? {}).flatMap((source) =>
      source.mutants.flatMap((mutant) => mutant.coveredBy ?? []),
    ),
  );
  for (const test of file.tests) {
    assert.ok(active.has(test.id), `Encoder test did not cover parser mutants: ${test.name}`);
  }
  return file.tests.length;
}
if (isMain(import.meta.url)) {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(`Verified ${assertEncoderDiscovery(report)} active genuine encoder mutation tests`);
}
