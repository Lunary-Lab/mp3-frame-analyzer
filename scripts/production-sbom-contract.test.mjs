import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionSbom } from './production-sbom.mjs';
import { repositoryRoot, runNpm } from './release-utils.mjs';

function fixture() {
  const pkg = {
    name: 'sbom-contract-fixture',
    version: '1.0.0',
    dependencies: {
      'runtime-root': '1.0.0',
      'another-root': '1.0.0',
      alias: 'npm:@fixture/real@2.0.0',
    },
    devDependencies: { 'dev-root': '1.0.0' },
  };
  const packages = {
    '': { ...pkg },
    'node_modules/runtime-root': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
    'node_modules/another-root': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
    'node_modules/alias': { name: '@fixture/real', version: '2.0.0' },
    'node_modules/shared': { version: '1.0.0' },
    'node_modules/another-root/node_modules/shared': { version: '2.0.0' },
    'node_modules/dev-root': { version: '1.0.0', dev: true, dependencies: { shared: '^1.0.0' } },
  };
  for (const [path, record] of Object.entries(packages)) {
    if (path) record.integrity = `sha512-${Buffer.alloc(64, path.length).toString('base64')}`;
  }
  return { pkg, lock: { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages } };
}

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'sbom-contract-test-'));
  const { pkg, lock } = fixture();
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
    await callback(root, lock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function changedOutput(mutate) {
  return async (args, options) => {
    const result = await runNpm(args, options);
    if (args[0] !== 'sbom') return result;
    const value = JSON.parse(result.stdout);
    mutate(value);
    return { ...result, stdout: JSON.stringify(value) };
  };
}

test('native graph command stays offline and script-free, fails closed, and removes temporary inputs', async () => {
  await withFixture(async (root) => {
    const commands = [];
    let temporary;
    await assert.rejects(
      productionSbom(root, {
        execute: async (args, options) => {
          commands.push(args[0]);
          temporary = options.cwd;
          for (const flag of [
            '--offline',
            '--ignore-scripts',
            '--no-audit',
            '--package-lock-only',
          ]) {
            assert.ok(args.includes(flag), flag);
          }
          if (args[0] === 'ls') throw new Error('synthetic native graph failure');
          return runNpm(args, options);
        },
      }),
      /synthetic native graph failure/,
    );
    assert.deepEqual(commands, ['sbom', 'ls']);
    await assert.rejects(readFile(join(temporary, 'package-lock.json')), { code: 'ENOENT' });
  });
});

test('native production profile preserves aliases, nested versions and shared prod/dev ancestry', async () => {
  await withFixture(async (root) => {
    const sbom = await productionSbom(root);
    assert.deepEqual(sbom.components.map((component) => component['bom-ref']).sort(), [
      '@fixture/real@2.0.0',
      'another-root@1.0.0',
      'runtime-root@1.0.0',
      'shared@1.0.0',
      'shared@2.0.0',
    ]);
    const graph = new Map(sbom.dependencies.map(({ ref, dependsOn }) => [ref, dependsOn]));
    assert.deepEqual(graph.get('runtime-root@1.0.0'), ['shared@1.0.0']);
    assert.deepEqual(graph.get('another-root@1.0.0'), ['shared@2.0.0']);
    assert.deepEqual([...graph.get('sbom-contract-fixture@1.0.0')].sort(), [
      '@fixture/real@2.0.0',
      'another-root@1.0.0',
      'runtime-root@1.0.0',
    ]);
  });
});

for (const [name, mutate] of [
  [
    'unsupported schema version',
    (bom) => {
      bom.specVersion = '999';
    },
  ],
  [
    'schema-invalid BOM version',
    (bom) => {
      bom.version = 0;
    },
  ],
  [
    'schema-invalid component property',
    (bom) => {
      bom.components[0].unexpected = true;
    },
  ],
  [
    'missing root dependency edge',
    (bom) => {
      bom.dependencies.find((row) => row.ref === 'sbom-contract-fixture@1.0.0').dependsOn.pop();
    },
  ],
  [
    'all dependency edges removed',
    (bom) => {
      for (const row of bom.dependencies) row.dependsOn = [];
    },
  ],
  [
    'wrong but existing dependency target',
    (bom) => {
      bom.dependencies.find((row) => row.ref === 'runtime-root@1.0.0').dependsOn = ['shared@2.0.0'];
    },
  ],
  [
    'extra dependency edge',
    (bom) => {
      bom.dependencies.find((row) => row.ref === 'shared@1.0.0').dependsOn = ['runtime-root@1.0.0'];
    },
  ],
  [
    'dangling dependency edge',
    (bom) => {
      bom.dependencies[0].dependsOn.push('absent@1.0.0');
    },
  ],
  [
    'altered component SHA-512',
    (bom) => {
      bom.components[0].hashes[0].content = '00'.repeat(64);
    },
  ],
  [
    'missing component SHA-512',
    (bom) => {
      delete bom.components[0].hashes;
    },
  ],
  [
    'downgraded component hash',
    (bom) => {
      bom.components[0].hashes = [{ alg: 'SHA-256', content: '00'.repeat(32) }];
    },
  ],
]) {
  test(`production gate rejects ${name}`, async () => {
    await withFixture(async (root) => {
      await assert.rejects(productionSbom(root, { execute: changedOutput(mutate) }));
    });
  });
}

test('current runtime inventory remains 51 components and 67 dependency edges with exact lock hashes', async () => {
  const lock = JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const sbom = await productionSbom(repositoryRoot);
  assert.equal(sbom.components.length, 51);
  assert.equal(
    sbom.dependencies.reduce((sum, row) => sum + row.dependsOn.length, 0),
    67,
  );
  for (const [path, record] of Object.entries(lock.packages)) {
    if (!path || record.dev === true) continue;
    const name = record.name ?? path.split('node_modules/').at(-1);
    const component = sbom.components.find(
      (item) => item['bom-ref'] === `${name}@${record.version}`,
    );
    assert.deepEqual(component.hashes, [
      {
        alg: 'SHA-512',
        content: Buffer.from(record.integrity.slice(7), 'base64').toString('hex'),
      },
    ]);
  }
});
