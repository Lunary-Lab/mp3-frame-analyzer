import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planReuse, testClosures } from './mutation-impact.mjs';

const testFile = 'tests/value.test.ts';
const moduleFile = 'src/mp3/value.ts';
const locations = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
function closure(source, extra = []) {
  const files = new Map([[testFile, source], [moduleFile, 'export const value = 1;'], ...extra]);
  return testClosures(files, [testFile]).get(testFile);
}

const safeImports = [
  "import '../src/mp3/value.js';",
  "export * from '../src/mp3/value.js';",
  "export { value } from '../src/mp3/value.js';",
  "import('../src/mp3/value.js');",
  "require('../src/mp3/value.js');",
  "vi.mock('../src/mp3/value.js');",
  "vi.doMock('../src/mp3/value.js');",
  "vi.importActual('../src/mp3/value.js');",
  "vi.importMock('../src/mp3/value.js');",
  "import type { value } from '../src/mp3/value.js';",
];
for (const source of safeImports) {
  test(`module discovery preserves ${source}`, () => {
    assert.deepEqual(closure(source), {
      files: new Set([testFile, moduleFile]),
      uncertain: false,
      reads: false,
      writes: false,
    });
  });
}
const opaqueImports = [
  'import(name);',
  'import();',
  'require(name);',
  'vi.mock(name);',
  "import value = require('../src/mp3/value.js');",
  "import '../missing.js';",
  "import '../../../escape.js';",
  "import 'unknown';",
  "import '/absolute.js';",
  'eval(code);',
  'Function(code);',
  'fetch(url);',
  'WebSocket(url);',
  'new Function(code);',
  'new Worker(url);',
  'new WebSocket(url);',
  'process.getBuiltinModule(name);',
  'process.binding(name);',
  'process._linkedBinding(name);',
  'export const = ;',
];
for (const source of opaqueImports) {
  test(`opaque import or execution preserves conservative uncertainty: ${source}`, () => {
    assert.equal(closure(source).uncertain, true);
  });
}
const filesystemImports = [
  ["import { readFile } from 'node:fs';", false],
  ["import { readFile as read } from 'node:fs/promises';", false],
  ["import { writeFile } from 'node:fs/promises';", true],
  ["import * as fs from 'node:fs';", true],
  ["import fs from 'node:fs';", true],
  ["import 'node:fs';", true],
  ["export { readFile } from 'node:fs';", true],
  ["import('node:fs');", true],
  ["require('node:fs');", true],
  ["vi.mock('node:fs');", true],
];
for (const [source, writes] of filesystemImports) {
  test(`filesystem capability preserves ${source}`, () => {
    assert.deepEqual(closure(source), {
      files: new Set([testFile]),
      uncertain: false,
      reads: true,
      writes,
    });
  });
}

test('ambiguous NodeNext resolution remains uncertain instead of choosing a candidate', () => {
  assert.equal(
    closure("import '../src/mp3/value.js';", [['src/mp3/value.js', '']]).uncertain,
    true,
  );
});

test('missing test source has an uncertain one-node closure', () => {
  assert.deepEqual(testClosures(new Map(), [testFile]).get(testFile), {
    files: new Set([testFile]),
    uncertain: true,
    reads: false,
    writes: false,
  });
});

function fixture(testSource = "import '../src/mp3/value.js';") {
  const source = 'export const value = 1;';
  const report = {
    files: {
      [moduleFile]: {
        source,
        mutants: [
          {
            id: '0',
            status: 'Killed',
            testsCompleted: 1,
            killedBy: ['0'],
            duration: 1,
            mutatorName: 'NumberLiteral',
            replacement: '0',
            location: locations,
          },
        ],
      },
    },
    testFiles: {
      [testFile]: { source: testSource, tests: [{ id: '0', name: 'value', location: locations }] },
    },
  };
  return {
    report,
    files: new Map([
      [moduleFile, source],
      [testFile, testSource],
    ]),
  };
}

const unsafeGraphs = [
  ["import 'unknown'; import { writeFile } from 'node:fs';", 'Unresolved import impact'],
  ["import { writeFile, readFile } from 'node:fs';", 'Shared external-state capability'],
  ["import { readFile } from 'node:fs';", 'Changed external-input test'],
];
for (const [source, reason] of unsafeGraphs) {
  test(`impact rejection precedence preserves ${reason}`, () => {
    const f = fixture();
    f.files.set(testFile, source);
    assert.deepEqual(planReuse(f.report, f.files), {
      report: null,
      reason: `${reason}: ${testFile}`,
    });
  });
}

test('read capabilities propagate transitively and always exclude old killing witnesses', () => {
  const f = fixture();
  const source = "import { readFile } from 'node:fs'; export const value = 1;";
  f.report.files[moduleFile].source = source;
  f.files.set(moduleFile, source);
  const before = structuredClone(f.report);
  const result = planReuse(f.report, f.files);
  assert.equal(result.eligible, 0);
  assert.equal(result.rerun, 1);
  assert.deepEqual(result.affectedTests, [testFile]);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.reason, 'validated unchanged inputs');
  assert.deepEqual(f.report, before);
});

test('only unaffected existing witnesses are retained without mutating the raw report', () => {
  const f = fixture();
  const other = 'tests/other.test.ts';
  f.report.testFiles[other] = {
    source: '',
    tests: [{ id: '1', name: 'other', location: locations }],
  };
  f.files.set(other, '');
  f.report.files[moduleFile].mutants[0].killedBy = ['unknown', '0', '1'];
  f.files.set(testFile, '// changed');
  const before = structuredClone(f.report);
  const result = planReuse(f.report, f.files);
  assert.deepEqual(result.report.files[moduleFile].mutants[0].killedBy, ['1']);
  assert.equal(result.eligible, 1);
  assert.equal(result.rerun, 0);
  assert.deepEqual(result.changedFiles, [testFile]);
  assert.deepEqual(result.affectedTests, [testFile]);
  assert.equal(result.reason, 'validated unaffected killing-test witnesses');
  assert.deepEqual(f.report, before);
});
