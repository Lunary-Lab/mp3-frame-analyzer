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
  return assertEncoderShardDiscovery([report]);
}

export function assertEncoderShardDiscovery(reports) {
  const coveredNames = new Set();
  for (const report of reports) {
    const file = report.testFiles?.['tests/mp3/free-format-real.test.ts'];
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
      if (active.has(test.id)) coveredNames.add(test.name);
    }
  }
  for (const name of ENCODER_TEST_NAMES)
    assert.ok(coveredNames.has(name), `Encoder test did not cover parser mutants: ${name}`);
  return ENCODER_TEST_NAMES.length;
}
if (isMain(import.meta.url)) {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(`Verified ${assertEncoderDiscovery(report)} active genuine encoder mutation tests`);
}
