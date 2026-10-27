import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateResolvedGraph } from './sbom-graph.mjs';

function fixture() {
  const root = '/tmp/native-sbom-graph';
  const lock = {
    name: 'app',
    version: '1.0.0',
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { a: '1.0.0', b: '1.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { b: '1.0.0' } },
      'node_modules/b': { version: '1.0.0' },
    },
  };
  const leaf = { name: 'b', version: '1.0.0', path: `${root}/node_modules/b`, extraneous: false };
  const tree = {
    name: 'app',
    version: '1.0.0',
    path: root,
    extraneous: false,
    dependencies: {
      a: {
        name: 'a',
        version: '1.0.0',
        path: `${root}/node_modules/a`,
        extraneous: false,
        dependencies: { b: leaf },
      },
      b: structuredClone(leaf),
    },
  };
  const sbom = {
    dependencies: [
      { ref: 'app@1.0.0', dependsOn: ['a@1.0.0', 'b@1.0.0'] },
      { ref: 'a@1.0.0', dependsOn: ['b@1.0.0'] },
      { ref: 'b@1.0.0', dependsOn: [] },
    ],
  };
  return { root, lock, tree, sbom };
}

test('native logical graph comparison accepts repeated hoisted nodes without mutating inputs', () => {
  const value = fixture();
  const before = structuredClone(value);
  validateResolvedGraph(value.sbom, value.lock, value.tree, value.root);
  assert.deepEqual(value, before);
});

for (const [name, mutate] of [
  [
    'wrong native root',
    ({ tree }) => {
      tree.path = '/tmp/other';
    },
  ],
  [
    'unexpected native path',
    ({ tree }) => {
      tree.dependencies.a.path += '/extra';
    },
  ],
  [
    'wrong native version',
    ({ tree }) => {
      tree.dependencies.a.version = '2.0.0';
    },
  ],
  [
    'wrong native name',
    ({ tree }) => {
      tree.dependencies.a.name = 'c';
    },
  ],
  [
    'native resolution problem',
    ({ tree }) => {
      tree.dependencies.a.problems = ['invalid'];
    },
  ],
  [
    'native invalid flag',
    ({ tree }) => {
      tree.dependencies.a.invalid = true;
    },
  ],
  [
    'extraneous native node',
    ({ tree }) => {
      tree.dependencies.a.extraneous = true;
    },
  ],
  [
    'missing native edge',
    ({ tree }) => {
      delete tree.dependencies.a.dependencies.b;
    },
  ],
  [
    'truncated native expansion',
    ({ tree }) => {
      delete tree.dependencies.a.dependencies;
    },
  ],
  [
    'undeclared native edge',
    ({ tree }) => {
      tree.dependencies.a.dependencies.c = tree.dependencies.b;
    },
  ],
  [
    'missing required native child',
    ({ tree }) => {
      tree.dependencies.a.dependencies.b = {};
    },
  ],
  [
    'malformed native child',
    ({ tree }) => {
      tree.dependencies.a.dependencies.b = null;
    },
  ],
  [
    'missing SBOM graph node',
    ({ sbom }) => {
      sbom.dependencies.pop();
    },
  ],
  [
    'duplicate SBOM graph node',
    ({ sbom }) => {
      sbom.dependencies.push(sbom.dependencies[0]);
    },
  ],
]) {
  test(`native graph validation rejects ${name}`, () => {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateResolvedGraph(value.sbom, value.lock, value.tree, value.root));
  });
}

test('absent optional peer is accepted but cannot hide a required production dependency', () => {
  const value = fixture();
  const record = value.lock.packages['node_modules/a'];
  record.peerDependencies = { absent: '*' };
  record.peerDependenciesMeta = { absent: { optional: true } };
  value.tree.dependencies.a.dependencies.absent = {};
  validateResolvedGraph(value.sbom, value.lock, value.tree, value.root);
  record.dependencies.absent = '*';
  assert.throws(
    () => validateResolvedGraph(value.sbom, value.lock, value.tree, value.root),
    /required/,
  );
});
