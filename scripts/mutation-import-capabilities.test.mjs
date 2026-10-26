import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { executionIsolation } from './mutation-execution-guard.mjs';
import { sourceInput } from './mutation-compatibility.mjs';
import { testClosures } from './mutation-impact.mjs';

function closure(source) {
  return testClosures(new Map([['tests/module.test.ts', source]]), ['tests/module.test.ts']).get(
    'tests/module.test.ts',
  );
}

for (const source of [
  "import { createHash } from 'node:crypto';",
  "import { createHash as hash } from 'node:crypto';",
  "import { Readable } from 'node:stream';",
  "import { setImmediate as nextTurn } from 'node:timers/promises';",
  "import { assert, asyncProperty, integer, type Parameters } from 'fast-check';",
  "import { expect, it } from 'vitest';",
]) {
  test(`supports only reviewed external bindings: ${source}`, () => {
    assert.equal(closure(source).uncertain, false);
  });
}

for (const source of [
  "import { setEngine } from 'node:crypto';",
  "import { setEngine as createHash } from 'node:crypto';",
  "import * as crypto from 'node:crypto';",
  "import crypto from 'node:crypto';",
  "import('node:crypto');",
  "require('node:crypto');",
  "export { createHash } from 'node:crypto';",
  "import { join } from 'node:path';",
  "import assert from 'node:assert/strict';",
  "import { Buffer } from 'node:buffer';",
  "import { setPriority } from 'node:os';",
  "import { getCallSites } from 'node:util';",
  "import { setMaxListeners } from 'node:events';",
  "import fc from 'fast-check';",
  "import * as fc from 'fast-check';",
  "import { configureGlobal } from 'fast-check';",
  "import('fast-check');",
  "import('vitest');",
  "require('vitest');",
  "require('fast-check');",
  "export * from 'fast-check';",
  "import { Snapshots } from 'vitest';",
]) {
  test(`unknown module capability fails closed: ${source}`, () => {
    assert.equal(closure(source).uncertain, true);
  });
}

test('every real selected root and transitive import satisfies the complete reuse contract', async () => {
  const root = new URL('../', import.meta.url);
  const rootPaths = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const paths = [...rootPaths];
  for (const directory of ['src', 'tests'])
    for (const path of await readdir(new URL(directory, root), { recursive: true }))
      paths.push(`${directory}/${path}`);
  const files = new Map(
    await Promise.all(
      paths
        .filter(sourceInput)
        .map(async (path) => [path, await readFile(new URL(path, root), 'utf8')]),
    ),
  );
  const isolation = executionIsolation(files);
  assert.equal(isolation.supported, true, isolation.reason);
  assert.ok(isolation.testFiles.length > 0);
  for (const [path, closure] of testClosures(files, isolation.testFiles)) {
    assert.equal(closure.uncertain, false, path);
    assert.equal(closure.writes, false, path);
  }
});
