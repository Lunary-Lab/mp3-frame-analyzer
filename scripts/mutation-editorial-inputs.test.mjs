import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fingerprint, mutationInputs } from './mutation-cache-inputs.mjs';

test('only the two proven editorial paths preserve the mutation input key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-editorial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const cases = [
    ['fuzz/README.md', true],
    ['scripts/schemas/cyclonedx-1.5/README.md', true],
    ['fuzz/seeds/raw/example.bin', false],
    ['fuzz/regressions/raw/example.bin', false],
    ['scripts/schemas/cyclonedx-1.5/bom-1.5.schema.json', false],
    ['scripts/schemas/cyclonedx-1.5/spdx.schema.json', false],
    ['scripts/schemas/cyclonedx-1.5/jsf-0.82.schema.json', false],
    ['fuzz/NOTES.md', false],
    ['scripts/schemas/cyclonedx-1.5/NOTES.md', false],
    ['src/README.md', false],
  ];
  for (const [path] of cases) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'initial');
  }
  const capture = async () => fingerprint(await mutationInputs(root, {}, {}));
  const before = await capture();
  for (const [path, editorial] of cases) {
    await t.test(path, async () => {
      await writeFile(join(root, path), 'changed');
      try {
        const after = await capture();
        if (editorial) assert.equal(after, before);
        else assert.notEqual(after, before);
      } finally {
        await writeFile(join(root, path), 'initial');
      }
    });
  }
});
