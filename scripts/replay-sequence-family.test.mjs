import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyReplayProcess } from './classify-replay.mjs';

for (const [message, family] of [
  ['Sequence count 12: got another count', 'incorrect-sequence-count'],
  ['Expected explicit sequence ambiguity: got a count', 'missing-sequence-ambiguity'],
  ['Impossible sequence count: 0 for 864 bytes', 'impossible-sequence-count'],
]) {
  test(`sequence replay preserves the ${family} family independently of numbers`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mp3-sequence-replay-'));
    try {
      await mkdir(join(root, 'scripts'));
      await mkdir(join(root, 'fuzz'));
      await copyFile(
        new URL('./run-fuzz-case.mjs', import.meta.url),
        join(root, 'scripts/run-fuzz-case.mjs'),
      );
      await writeFile(
        join(root, 'fuzz/sequences.fuzz.mjs'),
        `export async function fuzz() { throw new Error(${JSON.stringify(message)}); }`,
      );
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts/run-fuzz-case.mjs'), 'sequences'],
        { input: Buffer.alloc(0), encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(classifyReplayProcess(result), `Error:${family}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
