import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { readJson, repositoryRoot } from './release-utils.mjs';

// These guards turn upstream fixes into failing dependency-update PRs, so the
// temporary arrangements in TODO.md are removed rather than kept indefinitely.
const pkg = await readJson(join(repositoryRoot, 'package.json'));
const lock = await readJson(join(repositoryRoot, 'package-lock.json'));

test('the scoped qs override stays only while typed-rest-client pins vulnerable qs', () => {
  assert.equal(pkg.overrides?.['typed-rest-client']?.qs, '6.16.1');
  assert.equal(
    lock.packages['node_modules/typed-rest-client']?.dependencies?.qs,
    '6.15.1',
    'typed-rest-client no longer pins qs 6.15.1: remove the scoped override, regenerate the lockfile, and rerun the audits',
  );
  assert.equal(lock.packages['node_modules/qs']?.version, '6.16.1');
});

test('the TypeScript 6 alias stays only while typescript-eslint excludes TypeScript 7', () => {
  assert.equal(lock.packages['node_modules/typescript']?.name, '@typescript/typescript6');
  assert.equal(
    lock.packages['node_modules/typescript-eslint']?.peerDependencies?.typescript,
    '>=4.8.4 <6.1.0',
    'typescript-eslint changed its supported TypeScript range: reassess removing the TypeScript 6 alias',
  );
});
