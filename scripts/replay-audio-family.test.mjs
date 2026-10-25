import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyReplayProcess } from './classify-replay.mjs';
import { minimizeBytes } from './minimize-core.mjs';

test('audio-count replay retains its distinct failure family while counts change during reduction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp3-audio-replay-test-'));
  try {
    for (const directory of ['scripts', 'fuzz', 'dist/mp3']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    for (const file of [
      'scripts/run-fuzz-case.mjs',
      'fuzz/structured.fuzz.mjs',
      'fuzz/create-structured.mjs',
      'fuzz/oracles.mjs',
    ]) {
      await copyFile(new URL(`../${file}`, import.meta.url), join(root, file));
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    // Deliberately ignore only the exclusion option in this isolated wrapper.
    // The real parser still traverses the real generator's bytes, so physical
    // counting succeeds and only the audio-count oracle fails.
    await writeFile(
      join(root, 'dist/mp3/count-frames.js'),
      `import { countMp3Frames as actual } from ${JSON.stringify(new URL('../src/mp3/count-frames.ts', import.meta.url).href)};
export async function countMp3Frames(input) { return actual(input); }`,
    );
    await writeFile(
      join(root, 'dist/mp3/errors.js'),
      `export { Mp3ParseError } from ${JSON.stringify(new URL('../src/mp3/errors.ts', import.meta.url).href)};`,
    );
    const failure = (bytes) => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', join(root, 'scripts/run-fuzz-case.mjs'), 'structured'],
        { input: bytes, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(result.error, undefined);
      if (result.status === 0) return classifyReplayProcess(result);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^FUZZ_FAILURE /m);
      return classifyReplayProcess(result);
    };
    const input = Buffer.from([3, 16, 16]);
    const signature = failure(input);
    const reduced = await minimizeBytes(input, (bytes) => failure(bytes) === signature, {
      maxProbes: 20,
      budgetMs: 30_000,
    });
    assert.equal(reduced.timedOut, false);
    assert.equal(reduced.bytes.length, 1, 'The same audio-count failure has a one-byte reproducer');
    assert.equal(signature, 'Error:incorrect-audio-frame-count');
    assert.equal(failure(Buffer.from([16])), signature);
    assert.notEqual(signature, 'Error:incorrect-frame-count');
    assert.notEqual(signature, 'Error:impossible-frame-count');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
