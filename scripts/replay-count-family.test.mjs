import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyReplayProcess } from './classify-replay.mjs';
import { minimizeBytes } from './minimize-core.mjs';

test('impossible-count replay retains its failure family while irrelevant bytes are removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp3-count-replay-test-'));
  try {
    for (const directory of ['scripts', 'fuzz', 'dist/mp3']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    for (const file of ['scripts/run-fuzz-case.mjs', 'fuzz/raw.fuzz.mjs', 'fuzz/oracles.mjs']) {
      await copyFile(new URL(`../${file}`, import.meta.url), join(root, file));
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    // Deliberately violate the parser invariant, then exercise the real oracle,
    // replay runner, classifier and reducer without changing production code.
    await writeFile(
      join(root, 'dist/mp3/count-frames.js'),
      'export async function countMp3Frames() { return 0; }',
    );
    await writeFile(
      join(root, 'dist/mp3/errors.js'),
      `export { Mp3ParseError } from ${JSON.stringify(new URL('../src/mp3/errors.ts', import.meta.url).href)};`,
    );
    const failure = (bytes) => {
      const result = spawnSync(process.execPath, [join(root, 'scripts/run-fuzz-case.mjs'), 'raw'], {
        input: bytes,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      return classifyReplayProcess(result);
    };
    const input = Buffer.from('irrelevant bytes');
    const signature = failure(input);
    const reduced = await minimizeBytes(input, (bytes) => failure(bytes) === signature, {
      maxProbes: 80,
      budgetMs: 30_000,
    });
    assert.equal(reduced.timedOut, false);
    assert.equal(reduced.bytes.length, 0, 'The same impossible-count failure needs no input bytes');
    assert.equal(signature, 'Error:impossible-frame-count');
    assert.equal(failure(Buffer.alloc(0)), signature);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
