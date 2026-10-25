import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  productionProjection,
  validateProductionInventory,
  productionSbom,
} from './production-sbom.mjs';
import { runNpm, repositoryRoot } from './release-utils.mjs';

function fixture() {
  const pkg = {
    name: 'sbom-shared-dependency-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { 'runtime-root': '1.0.0' },
    devDependencies: { 'dev-root': '1.0.0' },
    scripts: {
      install: "node -e \"require('fs').writeFileSync('lifecycle-was-run','unexpected')\"",
    },
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { ...pkg },
      'node_modules/runtime-root': { version: '1.0.0', dependencies: { shared: '1.0.0' } },
      'node_modules/dev-root': { version: '1.0.0', dev: true, dependencies: { shared: '1.0.0' } },
      'node_modules/shared': { version: '1.0.0' },
    },
  };
  return { pkg, lock };
}

async function temporaryFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'production-sbom-test-'));
  const { pkg, lock } = fixture();
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  try {
    await callback(root, pkg, lock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('production projection retains exact shared/optional records and never mutates original inputs', () => {
  const { pkg, lock } = fixture();
  lock.packages['node_modules/optional-shared'] = {
    version: '2.0.0',
    devOptional: true,
    optional: true,
  };
  const before = structuredClone({ pkg, lock });
  const projected = productionProjection(pkg, lock);
  assert.equal(projected.pkg.devDependencies, undefined);
  assert.equal(projected.lock.packages[''].devDependencies, undefined);
  assert.equal(projected.lock.packages['node_modules/dev-root'], undefined);
  assert.deepEqual(
    projected.lock.packages['node_modules/shared'],
    lock.packages['node_modules/shared'],
  );
  assert.deepEqual(
    projected.lock.packages['node_modules/optional-shared'],
    lock.packages['node_modules/optional-shared'],
  );
  assert.deepEqual({ pkg, lock }, before);
});

test('native offline npm regression includes a dependency shared by production and dev paths', async () => {
  await temporaryFixture(async (root, pkg, lock) => {
    const original = await runNpm(
      [
        'sbom',
        '--omit=dev',
        '--package-lock-only',
        '--sbom-format=cyclonedx',
        '--sbom-type=application',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--cache',
        join(root, 'cache'),
      ],
      { cwd: root },
    );
    const before = JSON.parse(original.stdout);
    assert.ok(
      !before.components.some((component) => component.name === 'shared'),
      'The pinned npm11 shared-dependency omission characterization changed; review the workaround',
    );
    const after = await productionSbom(root);
    assert.deepEqual(after.components.map((component) => component.name).sort(), [
      'runtime-root',
      'shared',
    ]);
    validateProductionInventory(after, lock);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), pkg);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')), lock);
    assert.ok(!(await readdir(root)).includes('lifecycle-was-run'));
  });
});

test('real production lock inventory includes every unique runtime name/version', async () => {
  const lock = JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const sbom = await productionSbom(repositoryRoot);
  validateProductionInventory(sbom, lock);
  for (const name of [
    'ajv',
    'fast-deep-equal',
    'fast-uri',
    'json-schema-traverse',
    'require-from-string',
  ]) {
    assert.ok(
      sbom.components.some((component) => component.name === name),
      name,
    );
  }
});

test('aliases validate canonical package identity without misreading npm11 display names', async () => {
  await temporaryFixture(async (root, pkg, lock) => {
    pkg.dependencies.alias = 'npm:@fixture/real@2.0.0';
    lock.packages[''].dependencies = pkg.dependencies;
    lock.packages['node_modules/alias'] = { name: '@fixture/real', version: '2.0.0' };
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
    const sbom = await productionSbom(root);
    const alias = sbom.components.find((component) => component.name === 'alias');
    assert.equal(alias['bom-ref'], '@fixture/real@2.0.0');
    assert.equal(alias.purl, 'pkg:npm/%40fixture/real@2.0.0');
    validateProductionInventory(sbom, lock);
    alias.version = '2.0.1';
    assert.throws(() => validateProductionInventory(sbom, lock), /identity/);
  });
});

test('missing, extra, duplicate and malformed component inventories fail closed', async () => {
  await temporaryFixture(async (root, _pkg, lock) => {
    const valid = await productionSbom(root);
    for (const mutate of [
      (sbom) => {
        sbom.components.pop();
      },
      (sbom) => {
        sbom.components.push({ ...sbom.components[0] });
      },
      (sbom) => {
        sbom.components[0].purl = 'pkg:npm/wrong@1.0.0';
      },
      (sbom) => {
        sbom.components[0]['bom-ref'] = 'extra@1.0.0';
      },
      (sbom) => {
        sbom.dependencies[0].dependsOn.push('missing@1.0.0');
      },
      (sbom) => {
        sbom.components = null;
      },
    ]) {
      const broken = structuredClone(valid);
      mutate(broken);
      assert.throws(() => validateProductionInventory(broken, lock));
    }
  });
});

test('temporary projection is removed on command, JSON and inventory failure with offline/script guards', async () => {
  await temporaryFixture(async (root) => {
    let directory;
    for (const result of ['throw', 'malformed', '{"components":[]}']) {
      await assert.rejects(
        productionSbom(root, {
          execute: async (args, options) => {
            directory = options.cwd;
            for (const flag of [
              '--offline',
              '--ignore-scripts',
              '--no-audit',
              '--package-lock-only',
            ]) {
              assert.ok(args.includes(flag), flag);
            }
            assert.ok(!args.includes('install') && !args.includes('ci'));
            if (result === 'throw') throw new Error('synthetic failure');
            return { stdout: result };
          },
        }),
      );
      await assert.rejects(readFile(join(directory, 'package.json')), { code: 'ENOENT' });
    }
  });
});
