import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import { reviewedDataAccess } from './mutation-reviewed-data-access.mjs';
import { opaqueCapability } from './mutation-module-capabilities.mjs';
import { testClosures } from './mutation-impact.mjs';

const path = 'tests/helpers/mp3-fixtures.ts';
const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');

test('data access permission binds exact path, whole source and individual AST site', () => {
  const sites = reviewedDataAccess(path, source);
  assert.deepEqual([...sites], ['BITRATES[bitrateIndex]', 'SAMPLE_RATES[sampleRateIndex]']);
  assert.equal(reviewedDataAccess('tests/copied.ts', source).size, 0);
  assert.equal(reviewedDataAccess(path, source + '\n// edited').size, 0);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    assert.equal(opaqueCapability(node, sites), false, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
});

for (const extra of [
  "import { readFileSync } from 'node:fs'; const mode = readFileSync('docs/input.md');",
  "const key='con'+'structor'; const load=(()=>{})[key]; load(code)();",
]) {
  test(`a reviewed module cannot acquire capabilities under its old source witness: ${extra}`, () => {
    const files = new Map([
      ['tests/fixture.test.ts', "import './helpers/mp3-fixtures.js';"],
      [path, source + '\n' + extra],
    ]);
    const closure = testClosures(files, ['tests/fixture.test.ts']).get('tests/fixture.test.ts');
    assert.equal(closure.uncertain, true);
  });
}

test('site exceptions never bypass other checks at or beneath an allowed access', () => {
  const text = 'process[key]; expect.getState(); const { constructor } = (() => {});';
  const ast = ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true);
  const sites = new Set(['process[key]']);
  let opaque = 0;
  function visit(node) {
    if (opaqueCapability(node, sites)) opaque++;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(opaque >= 3);
});
