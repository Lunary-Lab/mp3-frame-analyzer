import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyReplayProcess } from './classify-replay.mjs';

async function replay(moduleSource, check) {
  const root = await mkdtemp(join(tmpdir(), 'mp3-replay-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'fuzz'));
    await copyFile(
      new URL('./run-fuzz-case.mjs', import.meta.url),
      join(root, 'scripts/run-fuzz-case.mjs'),
    );
    if (moduleSource !== undefined) {
      await writeFile(join(root, 'fuzz/raw.fuzz.mjs'), moduleSource);
    }
    const result = spawnSync(process.execPath, [join(root, 'scripts/run-fuzz-case.mjs'), 'raw'], {
      input: Buffer.from('ordinary test bytes'),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    check(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [name, source] of [
  ['missing target', undefined],
  [
    'missing compiled parser dependency',
    "import '../dist/mp3/count-frames.js'; export async function fuzz() {}",
  ],
  [
    'target initialization failure',
    "throw new Error('Target initialization failed'); export async function fuzz() {}",
  ],
]) {
  test(`${name} is an infrastructure failure, not a fuzz crash`, async () => {
    await replay(source, (result) => {
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /^FUZZ_FAILURE /m);
      assert.throws(() => classifyReplayProcess(result), /without a recognized failure marker/);
    });
  });
}

test('a successfully loaded target still reports reproducible fuzz failures', async () => {
  await replay(
    "export async function fuzz() { throw new Error('Chunk-boundary dependence: test failure'); }",
    (result) => {
      assert.equal(result.status, 1);
      assert.equal(classifyReplayProcess(result), 'Error:chunk-invariance');
    },
  );
});

test('a successfully loaded target can still complete cleanly', async () => {
  await replay('export async function fuzz() {}', (result) => {
    assert.equal(result.status, 0);
    assert.equal(classifyReplayProcess(result), null);
  });
});
