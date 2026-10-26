import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeDependencyPaths } from './mutation-runtime-inputs.mjs';

const root = 'scripts/run-mutations.mjs';
test('runtime closure includes transitive imports, re-exports and cycles at normally mutable paths', () => {
  const files = new Map([
    [
      root,
      "import './helper.mjs'; import ts from 'typescript'; import { readFile } from 'node:fs/promises';",
    ],
    ['scripts/helper.mjs', "export * from '../src/helper.js';"],
    ['src/helper.ts', "import '../scripts/helper.mjs';"],
    ['scripts/release-smoke-process.mjs', 'unrelated'],
  ]);
  assert.deepEqual(
    runtimeDependencyPaths(files),
    new Set([root, 'scripts/helper.mjs', 'src/helper.ts']),
  );
});

for (const source of [
  "import './missing.mjs';",
  "import '../../../external.mjs';",
  "import './helper.js';",
  "await import('./helper.mjs');",
  "const path = './helper.mjs'; await import(path);",
  "require('./helper.mjs');",
  "import helper = require('./helper.mjs');",
  'export const = ;',
]) {
  test(`runtime dependencies fail closed for ${source}`, () => {
    const files = new Map([
      [root, source],
      ['scripts/helper.ts', 'export const x=1;'],
      ['scripts/helper.js', 'export const x=1;'],
    ]);
    assert.throws(() => runtimeDependencyPaths(files), /mutation runtime/);
  });
}

for (const source of [
  "import { createRequire } from 'node:module'; const load=createRequire(import.meta.url); load('./release-smoke-process.mjs');",
  "import * as modules from 'node:module'; modules.createRequire(import.meta.url);",
  "import { runInNewContext } from 'node:vm';",
  "const resolve=import.meta.resolve; resolve('./release-smoke-process.mjs');",
  "import.meta.resolve('./release-smoke-process.mjs');",
  "import.meta['resolve']('vitest/package.json');",
  "import 'unknown-package';",
]) {
  test(`runtime loader aliases and unsupported roots fail closed: ${source}`, () => {
    assert.throws(() => runtimeDependencyPaths(new Map([[root, source]])), /mutation runtime/);
  });
}

test('only the two reviewed literal package resolutions are accepted', () => {
  const source =
    "import.meta.resolve('vitest/package.json'); import.meta.resolve('@stryker-mutator/core/package.json');";
  assert.deepEqual(runtimeDependencyPaths(new Map([[root, source]])), new Set([root]));
});
