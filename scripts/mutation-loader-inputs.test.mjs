import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateLoaderInputs } from './mutation-loader-inputs.mjs';

const fixture = () =>
  new Map([
    ['package.json', '{"type":"module"}'],
    ['tsconfig.json', '{}'],
  ]);

test('canonical package and TypeScript inputs have no extra loading roots', async () => {
  const files = fixture();
  for (const path of ['package.json', 'tsconfig.json', 'tsconfig.lint.json'])
    files.set(path, await readFile(new URL('../' + path, import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateLoaderInputs(files));
});

test('missing root tsconfig cannot inherit untracked parent configuration', () => {
  const files = fixture();
  files.delete('tsconfig.json');
  assert.throws(() => validateLoaderInputs(files), /Missing bounded root tsconfig/);
  files.set('tsconfig.json', '{}');
  assert.doesNotThrow(() => validateLoaderInputs(files));
});

for (const [name, value] of [
  ['external source selection', { include: ['../outside/**/*.ts'] }],
  ['opaque source selection', { include: {} }],
  ['null compiler data', { compilerOptions: null }],
  ['resource inheritance', { extends: './docs/options.md' }],
  ['external inheritance', { extends: '../tsconfig.json' }],
  ['package inheritance', { extends: 'external-config' }],
  ['array inheritance', { extends: ['./tsconfig.json'] }],
  ['project references', { references: [{ path: '../outside' }] }],
  ['resolver paths', { compilerOptions: { paths: { '#helper': ['./docs/helper.md'] } } }],
  ['resolver base directory', { compilerOptions: { baseUrl: '../outside' } }],
  ['transform plugin', { compilerOptions: { plugins: [{ name: './reader.js' }] } }],
  ['external types', { compilerOptions: { types: ['../outside'] } }],
  ['external type roots', { compilerOptions: { typeRoots: ['../outside'] } }],
  ['custom libraries', { compilerOptions: { lib: ['../outside'] } }],
  ['opaque compiler data', { compilerOptions: { target: { read: 'docs/input.md' } } }],
])
  test(`rejects ${name} compiler execution dependency`, () => {
    const files = fixture();
    files.set('tsconfig.json', JSON.stringify(value));
    assert.throws(() => validateLoaderInputs(files));
  });

for (const path of [
  'src/tsconfig.json',
  'tests/tsconfig.json',
  'tsconfig.custom.json',
  'src/package.json',
  'tests/package.json',
])
  test(`rejects nested or alternate loading boundary: ${path}`, () => {
    const files = fixture();
    files.set(path, '{"type":"module"}');
    assert.throws(() => validateLoaderInputs(files));
  });

for (const [key, value] of [
  ['imports', { '#reader': './docs/input.md' }],
  ['exports', './docs/input.md'],
  ['main', './reader.js'],
  ['module', './reader.js'],
  ['browser', {}],
  ['loader', './reader.js'],
  ['vitest', {}],
  ['vite', {}],
  ['stryker', {}],
  ['type', 'commonjs'],
])
  test(`rejects unreviewed package ${key} resolver`, () => {
    const files = fixture();
    files.set('package.json', JSON.stringify({ type: 'module', [key]: value }));
    assert.throws(() => validateLoaderInputs(files));
  });

test('lint inheritance must resolve to the present bounded root config', () => {
  const files = fixture();
  files.delete('tsconfig.json');
  files.set('tsconfig.lint.json', '{"extends":"./tsconfig.json"}');
  assert.throws(() => validateLoaderInputs(files));
  files.set('tsconfig.json', '{}');
  assert.doesNotThrow(() => validateLoaderInputs(files));
  files.set('tsconfig.lint.json', '{"extends":"./docs/config.md"}');
  assert.throws(() => validateLoaderInputs(files));
});

test('missing and malformed loading inputs fail closed', () => {
  assert.throws(() => validateLoaderInputs(new Map()));
  for (const path of ['package.json', 'tsconfig.json', 'tsconfig.lint.json']) {
    const files = fixture();
    files.set(path, '{');
    assert.throws(() => validateLoaderInputs(files));
  }
});
