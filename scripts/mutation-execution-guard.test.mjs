import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { executionIsolation } from './mutation-execution-guard.mjs';

const define = (value) =>
  `import { defineConfig } from 'vitest/config'; export default defineConfig(${JSON.stringify(value)});`;
const stryker = JSON.parse(
  await readFile(new URL('../stryker.config.json', import.meta.url), 'utf8'),
);
function fixture() {
  return new Map([
    ['stryker.config.json', JSON.stringify(stryker)],
    ['vitest.config.ts', define({ test: { include: ['tests/**/*.test.ts'] } })],
    [
      'vitest.mutation.config.ts',
      define({
        test: { include: ['tests/a.test.ts'], isolate: true, fsModuleCache: false },
      }),
    ],
    ['tests/a.test.ts', ''],
    ['tests/b.test.ts', ''],
    ['package.json', '{"type":"module"}'],
    ['tsconfig.json', '{}'],
  ]);
}
function rejected(files) {
  const result = executionIsolation(files);
  assert.equal(result.supported, false, JSON.stringify(result));
  assert.match(result.reason, /Unbounded mutation execution roots:/);
}

test('recognizes canonical data-only configs and literal selected test roots', async () => {
  const files = fixture();
  for (const path of ['vitest.config.ts', 'vitest.mutation.config.ts'])
    files.set(path, await readFile(new URL('../' + path, import.meta.url), 'utf8'));
  const selected = [...files.get('vitest.mutation.config.ts').matchAll(/'([^']+\.test\.ts)'/g)].map(
    (match) => match[1],
  );
  for (const path of selected) files.set(path, '');
  assert.deepEqual(executionIsolation(files), { supported: true, testFiles: selected.sort() });
  assert.equal(selected.length, 18);
});

test('unselected opaque tests do not become mutation execution roots', () => {
  const files = fixture();
  files.set(
    'tests/added.test.ts',
    "import { execSync } from 'node:child_process'; execSync('opaque');",
  );
  files.set('src/nonparser.ts', "import 'unknown-package';");
  files.set('docs/readme.md', 'Unrelated passive content');
  assert.deepEqual(executionIsolation(files), { supported: true, testFiles: ['tests/a.test.ts'] });
});

test('literal glob is expanded freshly, including nested and newly introduced tests', () => {
  const files = fixture();
  files.set(
    'vitest.config.ts',
    define({
      test: { include: ['tests/**/*.test.ts'], maxWorkers: 1, fsModuleCache: false },
    }),
  );
  files.set('vitest.mutation.config.ts', "export { default } from './vitest.config.js';");
  files.set('tests/new/reader.test.ts', "import { readFile } from 'node:fs/promises';");
  assert.deepEqual(executionIsolation(files), {
    supported: true,
    testFiles: ['tests/a.test.ts', 'tests/b.test.ts', 'tests/new/reader.test.ts'],
  });
});

for (const [name, source] of [
  ['config resource read', "import { readFileSync } from 'node:fs';"],
  ['imported helper', "import './config-helper.js';"],
  ['side-effect package', "import 'opaque-plugin';"],
  ['dynamic path', 'await import(process.env.CONFIG);'],
  ['global reader', "process.getBuiltinModule('fs').readFileSync('docs/mode.md');"],
  ['namespace import', "import * as config from 'vitest/config';"],
  ['aliased import', "import { defineConfig as config } from 'vitest/config';"],
  ['extra import', "import { defineConfig, mergeConfig } from 'vitest/config';"],
  ['type-only import', "import type { defineConfig } from 'vitest/config';"],
  ['duplicate import', "import { defineConfig } from 'vitest/config';"],
  ['config declaration', 'const mode = true;'],
])
  test(`${name} is rejected before ignoring any resource changes`, () => {
    for (const path of ['vitest.config.ts', 'vitest.mutation.config.ts']) {
      const files = fixture();
      files.set(path, source + '\n' + files.get(path));
      files.set(
        'config-helper.ts',
        "import { readFileSync } from 'node:fs'; readFileSync('docs/mode.md');",
      );
      rejected(files);
    }
  });

for (const expression of [
  '() => ({ test: {} })',
  '{ test: { include: getTests(), fsModuleCache: false } }',
  "{ test: { ['include']: ['tests/a.test.ts'], fsModuleCache: false } }",
  "{ test: { get include() { return ['tests/a.test.ts']; }, fsModuleCache: false } }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false, ...external } }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false, setupFiles: ['./setup.ts'] } }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false, globalSetup: ['./setup.ts'] } }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false }, plugins: [plugin()] }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false }, plugins: [] }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false }, resolve: { alias: {} } }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false }, esbuild: {} }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false }, css: {} }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false }, __proto__: {} }",
  "{ test: { include: ['tests/a.test.ts'], fsModuleCache: false, fsModuleCache: true } }",
])
  test(`rejects unreviewed executable/configuration expression: ${expression}`, () => {
    const files = fixture();
    files.set(
      'vitest.mutation.config.ts',
      `import { defineConfig } from 'vitest/config'; export default defineConfig(${expression});`,
    );
    rejected(files);
  });

for (const [key, value] of [
  ['isolate', false],
  ['fsModuleCache', true],
  ['execArgv', ['--require=./loader.cjs']],
  ['environment', './custom-environment.js'],
  ['pool', './custom-pool.ts'],
  ['poolOptions', {}],
  ['projects', ['./project.ts']],
  ['sequence', { sequencer: './sequencer.ts' }],
  ['coverage', { provider: 'custom', customProviderModule: './provider.js' }],
  ['benchmark', { setupFiles: ['./setup.ts'] }],
  ['maxWorkers', 2],
  ['testTimeout', -1],
])
  test(`rejects unreviewed ${key} test option`, () => {
    const files = fixture();
    files.set(
      'vitest.mutation.config.ts',
      define({
        test: {
          include: ['tests/a.test.ts'],
          fsModuleCache: false,
          [key]: value,
        },
      }),
    );
    rejected(files);
  });

test('missing/ambiguous/invalid selection and disabled isolation prerequisites reject', () => {
  for (const include of [
    [],
    ['tests/missing.test.ts'],
    ['tests/*.test.ts'],
    ['../test.ts'],
    ['tests/../a.test.ts'],
    ['tests/**/*.test.ts', 'tests/a.test.ts'],
    [null],
  ]) {
    const files = fixture();
    files.set('vitest.mutation.config.ts', define({ test: { include, fsModuleCache: false } }));
    rejected(files);
  }
  const files = fixture();
  files.set('vitest.mutation.config.ts', define({ test: { include: ['tests/a.test.ts'] } }));
  rejected(files);
  files.delete('vitest.mutation.config.ts');
  rejected(files);
});

for (const path of [
  'vite.config.ts',
  'vitest.config.js',
  'vitest.workspace.ts',
  'vitest.workspace.json',
  'stryker.config.mjs',
  'stryker.conf.json',
  '.stryker.conf.js',
])
  test(`rejects alternate implicit configuration root ${path}`, () => {
    const files = fixture();
    files.set(path, '');
    rejected(files);
  });

for (const [key, value] of [
  ['testRunner', 'command'],
  ['coverageAnalysis', 'off'],
  ['mutate', ['src/mp3/a.ts']],
  ['plugins', ['./reader-plugin.js']],
  ['buildCommand', 'node reader.js'],
  ['checkers', ['typescript']],
  ['vitest', { configFile: 'alternate.ts', pool: 'forks', related: false }],
  ['concurrency', 4],
  ['incremental', false],
  ['reporters', ['./reporter.js']],
  ['thresholds', { high: 100, low: 100, break: 1 }],
])
  test(`rejects unreviewed Stryker ${key} execution entry`, () => {
    const files = fixture();
    files.set('stryker.config.json', JSON.stringify({ ...stryker, [key]: value }));
    rejected(files);
  });

test('malformed config syntax and JSON fail closed without execution', () => {
  for (const path of ['vitest.config.ts', 'vitest.mutation.config.ts', 'stryker.config.json']) {
    const files = fixture();
    files.set(path, '{');
    rejected(files);
  }
});

test('mirrored parser selection is a bounded literal inventory glob, not executable discovery', () => {
  const files = fixture();
  files.set(
    'vitest.mutation.config.ts',
    define({
      test: {
        include: ['tests/mp3/**/*.test.ts'],
        isolate: true,
        fsModuleCache: false,
      },
    }),
  );
  files.set('tests/mp3/a.test.ts', '');
  files.set('tests/mp3/nested/b.test.ts', '');
  files.set('tests/http/opaque.test.ts', 'process.getBuiltinModule(name);');
  assert.deepEqual(executionIsolation(files).testFiles, [
    'tests/mp3/a.test.ts',
    'tests/mp3/nested/b.test.ts',
  ]);
  files.set('tests/mp3/new.test.ts', '');
  assert.ok(executionIsolation(files).testFiles.includes('tests/mp3/new.test.ts'));
  files.delete('tests/mp3/a.test.ts');
  assert.ok(!executionIsolation(files).testFiles.includes('tests/mp3/a.test.ts'));
  files.set(
    'vitest.mutation.config.ts',
    "import { defineConfig } from 'vitest/config'; import { discoverParserTests } from './scripts/discover.mjs'; export default defineConfig({test:{include:discoverParserTests()}});",
  );
  rejected(files);
});
