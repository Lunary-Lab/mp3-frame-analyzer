import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { assertReviewedRuntime } from './mutation-runtime-witness.mjs';

async function runtimeFiles() {
  const names = (await readdir(new URL('./', import.meta.url))).filter((name) =>
    name.endsWith('.mjs'),
  );
  return new Map(
    await Promise.all(
      names.map(async (name) => [
        `scripts/${name}`,
        await readFile(new URL(name, import.meta.url), 'utf8'),
      ]),
    ),
  );
}

const awaitedFiles = await runtimeFiles();

test('the complete actual wrapper/auditor closure matches its reviewed source witness', () => {
  assert.doesNotThrow(() => assertReviewedRuntime(awaitedFiles));
});

for (const path of [
  'scripts/run-mutations.mjs',
  'scripts/mutation-cache.mjs',
  'scripts/mutation-impact.mjs',
]) {
  test(`capturing changed runtime bytes cannot auto-approve ${path}`, () => {
    const files = new Map(awaitedFiles);
    files.set(path, files.get(path) + '\n// new execution shape must be reviewed\n');
    assert.throws(() => assertReviewedRuntime(files), /Unreviewed mutation runtime source/);
  });
}

test('a new transitive runtime helper cannot be blessed merely by a successful full baseline', () => {
  const files = new Map(awaitedFiles);
  files.set(
    'scripts/run-mutations.mjs',
    files.get('scripts/run-mutations.mjs') + "\nimport './extra.mjs';\n",
  );
  files.set(
    'scripts/extra.mjs',
    "import { readFileSync } from 'node:fs'; readFileSync('docs/mode.md');",
  );
  assert.throws(() => assertReviewedRuntime(files), /Unreviewed mutation runtime source/);
});
