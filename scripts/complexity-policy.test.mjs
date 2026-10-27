import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';
import { repositoryRoot } from './release-utils.mjs';

const eslint = new ESLint({ cwd: repositoryRoot });

test('complexity above ten is an error across maintained production TS and JS', async () => {
  for (const path of [
    'src/mp3/count-frames.ts',
    'src/runtime.js',
    'scripts/mutation-policy.mjs',
    'scripts/package-release.mjs',
    'scripts/mutation-cache.mjs',
    'fuzz/create-structured.mjs',
    'bench/parser.bench.ts',
    'bench/upload.k6.js',
    'eslint.config.mjs',
    'vitest.config.ts',
    'future-tool.cjs',
  ]) {
    const config = await eslint.calculateConfigForFile(path);
    assert.deepEqual(config.rules.complexity, [2, { max: 10 }], path);
    assert.deepEqual(
      config.rules['max-lines'],
      [2, { max: 300, skipBlankLines: true, skipComments: true }],
      path,
    );
    assert.deepEqual(
      config.rules['max-lines-per-function'],
      [2, { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }],
      path,
    );
    assert.equal(config.rules['max-len'][0], 2, path);
    assert.equal(config.rules['max-len'][1].code, 120, path);
  }
});

test('test code retains the separately reviewed advisory limit', async () => {
  for (const path of [
    'tests/mp3/count-frames.test.ts',
    'tests/helpers/mp3-fixtures.ts',
    'scripts/mutation-policy.test.mjs',
    'scripts/mutation-cache.test.mjs',
  ]) {
    const config = await eslint.calculateConfigForFile(path);
    assert.deepEqual(config.rules.complexity, [1, { max: 16 }], path);
  }
});

function functionWithComplexity(complexity) {
  const conditions = Array.from(
    { length: complexity - 1 },
    (_, index) => `if (value === ${index}) total++;`,
  ).join('\n');
  return `export function measured(value) { let total = 0; ${conditions} return total; }`;
}

test('lint accepts ten independent paths and rejects eleven at error severity', async () => {
  const [atLimit] = await eslint.lintText(functionWithComplexity(10), {
    filePath: 'scripts/complexity-probe.mjs',
  });
  assert.equal(atLimit.errorCount, 0);
  assert.equal(atLimit.warningCount, 0);
  const [overLimit] = await eslint.lintText(functionWithComplexity(11), {
    filePath: 'scripts/complexity-probe.mjs',
  });
  assert.equal(overLimit.errorCount, 1);
  assert.equal(overLimit.warningCount, 0);
  assert.equal(overLimit.messages[0].ruleId, 'complexity');
  assert.equal(overLimit.messages[0].severity, 2);
  assert.match(overLimit.messages[0].message, /complexity of 11.*Maximum allowed is 10/);
});

test('generated artifacts stay outside lint scope', async () => {
  for (const path of [
    'dist/server.js',
    'coverage/generated.js',
    'release/runtime.js',
    'reports/generated.js',
    '.cache/runtime.js',
    '.stryker-tmp/generated.js',
    'node_modules/dependency/index.js',
  ])
    assert.equal(await eslint.isPathIgnored(path), true, path);
});

async function violations(source, ruleId, filePath = 'scripts/size-probe.mjs') {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === ruleId);
}

test('production file size accepts 300 code lines and rejects 301, ignoring blanks and comments', async () => {
  const line = (index) => `export const value${index} = ${index};`;
  const atLimit = Array.from({ length: 300 }, (_, index) => line(index)).join('\n');
  assert.equal((await violations(atLimit, 'max-lines')).length, 0);
  assert.equal((await violations(atLimit + '\n' + line(300), 'max-lines')).length, 1);
  const commented = atLimit.replaceAll('\n', '\n\n// non-code comment\n');
  assert.equal((await violations(commented, 'max-lines')).length, 0);
});

function sizedFunction(lines, iife = false) {
  const start = iife ? '(() => {' : 'export function measured() {';
  const body = Array.from({ length: lines - 2 }, () => '  console.log(1);');
  return [start, ...body, iife ? '})();' : '}'].join('\n');
}

test('production functions and IIFEs accept 60 code lines and reject 61', async () => {
  for (const iife of [false, true]) {
    const atLimit = sizedFunction(60, iife);
    assert.equal((await violations(atLimit, 'max-lines-per-function')).length, 0);
    assert.equal((await violations(sizedFunction(61, iife), 'max-lines-per-function')).length, 1);
    assert.equal(
      (await violations(atLimit.replaceAll('\n', '\n\n// comment\n'), 'max-lines-per-function'))
        .length,
      0,
    );
  }
});

test('120-character width remains a hard cap outside narrow URL and standalone literal cases', async () => {
  for (const length of [120, 121]) {
    const line = '// ' + 'a'.repeat(length - 3);
    assert.equal((await violations(line, 'max-len')).length, Number(length > 120));
  }
  assert.equal(
    (await violations('// https://example.test/' + 'a'.repeat(140), 'max-len')).length,
    0,
  );
  for (const quote of ["'", '"', '`']) {
    const literal = quote + 'a'.repeat(140) + quote;
    assert.equal((await violations(`export const text =\n  ${literal};`, 'max-len')).length, 0);
    assert.equal((await violations(`export const text = ${literal};`, 'max-len')).length, 1);
    assert.equal((await violations(`${literal}; console.log(1);`, 'max-len')).length, 1);
  }
});

test('test tables keep width checks while helper modules retain production size gates', async () => {
  const table = 'scripts/size-policy.test.mjs';
  const helper = 'tests/helpers/mp3-fixtures.ts';
  const tableConfig = await eslint.calculateConfigForFile(table);
  const helperConfig = await eslint.calculateConfigForFile(helper);
  assert.equal(tableConfig.rules['max-lines'][0], 0);
  assert.equal(tableConfig.rules['max-lines-per-function'][0], 0);
  assert.equal(tableConfig.rules['max-len'][0], 2);
  assert.equal(helperConfig.rules['max-lines'][0], 2);
  assert.equal(helperConfig.rules['max-lines-per-function'][0], 2);
  assert.equal((await violations(sizedFunction(61), 'max-lines-per-function', table)).length, 0);
  assert.equal((await violations('// ' + 'a'.repeat(121), 'max-len', table)).length, 1);
});
