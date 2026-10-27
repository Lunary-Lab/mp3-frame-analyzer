import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { testClosures, planReuse } from './mutation-impact.mjs';
import { globalFingerprint } from './mutation-cache.mjs';
import { sha256 } from './mutation-policy.mjs';

// Exercise the public planner with an actual reviewed reader and its real static
// import closure; invented reader hashes would not test the committed contract.
const sourceFiles = new Map();
async function collect(directory) {
  for (const entry of await readdir(new URL('../' + directory, import.meta.url), {
    withFileTypes: true,
  })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) await collect(path);
    else if (path.endsWith('.ts'))
      sourceFiles.set(path, await readFile(new URL('../' + path, import.meta.url), 'utf8'));
  }
}
await collect('src');
await collect('tests');

const fixtures = [
  [
    'tests/count-frames.test.ts',
    ['tests/fixtures/cbr.mp3', 'tests/fixtures/vbr.mp3', 'tests/fixtures/no-xing.mp3'],
  ],
  ['tests/free-format-real.test.ts', ['tests/fixtures/lame-free-format.json']],
  ['tests/short-free-format.test.ts', ['tests/fixtures/short-free-format.json']],
  ['tests/free-format-metadata.test.ts', ['tests/fixtures/short-free-format.json']],
  ['tests/partial-metadata-prefix.test.ts', ['tests/fixtures/short-free-format.json']],
  [
    'tests/fuzz-regressions.test.ts',
    [
      'fuzz/regressions/raw/reserved-emphasis.bin',
      'fuzz/regressions/raw/truncated-header.bin',
      'fuzz/regressions/raw/oversized-id3-length.bin',
      'fuzz/regressions/raw/free-format-three-short-frames.bin',
      'fuzz/regressions/raw/free-format-minimum.bin',
      'fuzz/regressions/raw/free-format-prefix-only.bin',
      'fuzz/regressions/raw/free-format-prefix-crc.bin',
    ],
  ],
];

for (const [path, resources] of fixtures) {
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  const inventory = await Promise.all(
    resources.map(async (resource) => [
      resource,
      0o644,
      sha256(await readFile(new URL('../' + resource, import.meta.url))),
    ]),
  );
  const closure = (text = source, inputs = inventory, name = path) =>
    testClosures(new Map(sourceFiles).set(name, text), [name], inputs).get(name);
  test(`reviewed immutable resource reader retains its bounded dependencies: ${path}`, () => {
    assert.equal(closure().reads, false);
    for (const resource of resources) assert.ok(closure().files.has(resource), resource);
  });
  test(`resource contracts do not approve edited or renamed reader source: ${path}`, () => {
    assert.equal(closure(source + '\n// unreviewed change\n').reads, true);
    assert.equal(closure(source, inventory, 'tests/renamed.test.ts').reads, true);
  });
  test(`missing or unauthenticated resource inventory remains always affected: ${path}`, () => {
    assert.equal(closure(source, []).reads, true);
    assert.equal(closure(source, inventory.slice(1)).reads, true);
    assert.equal(
      closure(
        source,
        inventory.map(([name]) => [name, 'link', '../outside']),
      ).reads,
      true,
    );
    assert.equal(
      closure(
        source,
        inventory.map(([name, mode]) => [name, mode, 'bad']),
      ).reads,
      true,
    );
  });
}

const reader = 'tests/free-format-real.test.ts';
const parser = 'src/mp3/count-frames.ts';
const resource = 'tests/fixtures/lame-free-format.json';
const resources = [
  [resource, 0o644, sha256(await readFile(new URL('../' + resource, import.meta.url)))],
];
const location = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
const report = {
  files: {
    [parser]: {
      source: sourceFiles.get(parser),
      mutants: [
        {
          id: 'parser',
          status: 'Killed',
          killedBy: ['real-encoder'],
          testsCompleted: 1,
          mutatorName: 'NumberLiteral',
          replacement: '0',
          location,
        },
      ],
    },
  },
  testFiles: {
    [reader]: {
      source: sourceFiles.get(reader),
      tests: [{ id: 'real-encoder', name: 'real encoder', location }],
    },
  },
};
const plan = (options = {}) =>
  planReuse(report, sourceFiles, {
    baselineFiles: sourceFiles,
    baselineInputs: resources,
    currentInputs: resources,
    testFiles: [reader],
    ...options,
  });

test('an unchanged genuine encoder killing witness is reusable with both resource inventories', () => {
  assert.equal(plan().eligible, 1);
  assert.deepEqual(plan().affectedTests, []);
  assert.equal(plan({ baselineInputs: [] }).eligible, 0);
  assert.equal(plan({ currentInputs: [] }).eligible, 0);
});

test('resource changes affect its real reader even before global cache validation', () => {
  const changed = plan({ changedInputs: [resource] });
  assert.equal(changed.eligible, 0);
  assert.deepEqual(changed.affectedTests, [reader]);
});

test('every reviewed fixture remains globally bound, including content, mode, rename and deletion', () => {
  for (const [, paths] of fixtures) {
    for (const path of paths) {
      const baseline = { files: [[path, 0o644, 'a'.repeat(64)]] };
      for (const files of [
        [[path, 0o644, 'b'.repeat(64)]],
        [[path, 0o755, 'a'.repeat(64)]],
        [[path + '.renamed', 0o644, 'a'.repeat(64)]],
        [],
      ])
        assert.notEqual(globalFingerprint({ files }), globalFingerprint(baseline), path);
    }
  }
});

test('resource contracts never waive changed helper or parser dependencies', () => {
  for (const path of [parser, 'tests/helpers/mp3-fixtures.ts']) {
    const changed = new Map(sourceFiles).set(
      path,
      sourceFiles.get(path) + '\n// changed dependency\n',
    );
    const result = planReuse(report, changed, {
      baselineFiles: sourceFiles,
      baselineInputs: resources,
      currentInputs: resources,
      testFiles: [reader],
    });
    if (path === parser) {
      assert.equal(result.eligible, 0);
      assert.deepEqual(result.affectedTests, [reader]);
    } else {
      assert.equal(result.report, null);
      assert.match(result.reason, /Unresolved import impact/);
    }
  }
});

test('resource contracts reject duplicated inventory identities', () => {
  assert.equal(plan({ currentInputs: [...resources, ...resources] }).eligible, 0);
});

for (const change of [
  "URL = class extends URL { constructor() { super('file:///untracked/fixture'); } };",
  'Buffer.from = (() => Buffer.alloc(0)) as typeof Buffer.from;',
  'String.prototype.toString = () => "untracked";',
  'Object.defineProperty(URL, "prototype", { value: {} });',
  "import { readFile } from 'node:fs/promises'; export const callback = () => readFile('/untracked/fixture');",
  "import * as fs from 'node:fs/promises'; fs.readFile = async () => Buffer.alloc(0);",
]) {
  test(`even an unchanged baseline helper cannot bless an unreviewed resource execution shape: ${change}`, () => {
    const helper = 'src/mp3/errors.ts';
    const changed = new Map(sourceFiles).set(helper, sourceFiles.get(helper) + '\n' + change);
    const result = planReuse(report, changed, {
      baselineFiles: changed,
      baselineInputs: resources,
      currentInputs: resources,
      testFiles: [reader],
    });
    assert.ok(result.report === null || result.eligible === 0);
  });
}

test('external assessment sample remains an always-affected resource reader', () => {
  const path = 'tests/assessment-sample.test.ts';
  assert.equal(testClosures(sourceFiles, [path], resources).get(path).reads, true);
});
