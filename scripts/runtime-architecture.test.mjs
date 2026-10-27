import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { inspectRuntimeSource } from './runtime-architecture.mjs';

for (const [file, positives, negatives] of [
  ['original-patterns', 5, 6],
  ['runtime-execution', 27, 12],
]) {
  test(`native ESLint preserves every positive and negative ${file} example`, async () => {
    const source = await readFile(
      new URL(`../tests/runtime-architecture/${file}.ts.fixture`, import.meta.url),
      'utf8',
    );
    const findings = inspectRuntimeSource(source, 'fixture.ts');
    assert.ok(
      findings.every((finding) => !finding.fatal),
      'Fixture must parse, not fail incidentally',
    );
    const cases = source.split('\n').flatMap((line, index) => {
      const marker = /\/\/ (ruleid|ok):/.exec(line);
      return marker ? [{ line: index + 2, blocked: marker[1] === 'ruleid' }] : [];
    });
    assert.equal(cases.filter((item) => item.blocked).length, positives);
    assert.equal(cases.filter((item) => !item.blocked).length, negatives);
    for (const item of cases) {
      assert.equal(
        findings.some((finding) => finding.line === item.line),
        item.blocked,
        `${file}:${item.line}`,
      );
    }
  });
}

const blocked = [
  'const name="node:child_process" as const; require(name);',
  'require("child_process" as string);',
  'const name="child_process" satisfies string; import(name);',
  'require!("child_process");',
  '(require as Function)("child_process");',
  'import {createRequire} from "node:module"; const load=createRequire(import.meta.url); load?.("child_process");',
  'import {createRequire as make} from "module"; make(import.meta.url)("node:child_process");',
  'const {createRequire:make}=require("node:module"); const load=make(__filename); load("child_process");',
  'import {getBuiltinModule as load} from "node:process"; const alias=load; alias("child_process");',
  'import p from "node:process"; const {getBuiltinModule:load}=p; load("child_process");',
  'const load=require; load("child_process");',
  'const load=module.require; load("child_process");',
  'process["getBuiltinModule"]("child_process");',
  'const name="node:" + "child_process"; import(name);',
  'const e=eval; e("synthetic");',
  'setTimeout("synthetic", 1);',
  '/* eslint-disable */\neval("synthetic");',
  '/* eslint no-eval: off, no-restricted-syntax: off */\neval("synthetic");',
  '// eslint-disable-next-line architecture/no-process-loading\nrequire("child_process");',
  '// nosemgrep\neval("synthetic");',
];

test('native binding/constant resolution covers aliases and TypeScript wrappers without execution', () => {
  for (const source of blocked) {
    const findings = inspectRuntimeSource(source, 'fixture.ts');
    assert.ok(
      findings.some((finding) => finding.severity === 2 && !finding.fatal),
      source,
    );
  }
});

test('native fixed rules preserve benign loaders, labels and local/regex methods', () => {
  for (const source of [
    'const fake={getBuiltinModule:x=>x}; fake.getBuiltinModule("child_process");',
    'import {createRequire} from "node:module"; const load=createRequire(import.meta.url); load("node:stream");',
    'import {getBuiltinModule as load} from "some-library"; load("child_process");',
    'const x={exec(){}}; x.exec();',
    '/synthetic/.exec("synthetic");',
    'const label="require(\\"child_process\\")";',
    'const name="node:stream"; require(name);',
    'const require=(name:string)=>name; require("child_process_helpers");',
  ])
    assert.deepEqual(inspectRuntimeSource(source, 'fixture.ts'), [], source);
});

test('parse failures block and every supported runtime filename is actually inspected', () => {
  assert.ok(inspectRuntimeSource('const = ;', 'fixture.ts').some((finding) => finding.fatal));
  for (const filename of [
    '.hidden.ts',
    'nested/.hidden.ts',
    'a.tsx',
    'a.mts',
    'a.cts',
    'a.js',
    'a.jsx',
    'a.mjs',
    'a.cjs',
  ]) {
    const findings = inspectRuntimeSource('eval("synthetic");', filename);
    assert.ok(
      findings.some((finding) => finding.ruleId === 'no-eval'),
      filename,
    );
  }
  assert.throws(() => inspectRuntimeSource('eval("synthetic");', 'ignored.json'), /Unsupported/);
});
