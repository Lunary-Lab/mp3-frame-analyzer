import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNpm } from './release-utils.mjs';
import { validateSbomSchema } from './sbom-schema.mjs';
import { validateResolvedGraph } from './sbom-graph.mjs';

function productionEntries(lock) {
  assert.equal(lock.lockfileVersion, 3, 'Production SBOM requires the reviewed npm v3 lock format');
  assert.ok(lock.packages?.[''], 'Production lock root is missing');
  return Object.entries(lock.packages).filter(
    ([path, record]) => path !== '' && record.dev !== true,
  );
}

function identity(path, record) {
  assert.ok(
    path.startsWith('node_modules/') && !path.includes('\\'),
    'Unexpected production lock path',
  );
  assert.ok(
    path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Unsafe production lock path',
  );
  assert.ok(!record.link, 'Linked runtime dependencies need a separately reviewed SBOM policy');
  const alias = path.split('node_modules/').at(-1);
  const name = record.name ?? alias;
  assert.match(name, /^(?:@[\w.-]+\/)?[\w.-]+$/, 'Invalid locked production package name');
  assert.match(
    record.version,
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/,
    'Invalid locked package version',
  );
  return {
    name,
    alias,
    version: record.version,
    id: `${name}@${record.version}`,
    purl: `pkg:npm/${name.replace(/^@/, '%40')}@${record.version}`,
  };
}

function expectedInventory(lock) {
  const inventory = new Map();
  for (const [path, record] of productionEntries(lock)) {
    const item = identity(path, record);
    const encoded = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(record.integrity ?? '')?.[1];
    assert.ok(encoded, 'Production SBOM requires locked SHA-512 integrity');
    const bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.toString('base64'), encoded, 'Noncanonical production SHA-512 integrity');
    item.sha512 = bytes.toString('hex');
    const previous = inventory.get(item.id) ?? { ...item, displays: new Set([item.name]) };
    assert.equal(
      previous.sha512,
      item.sha512,
      'Conflicting integrity for one production component',
    );
    previous.displays.add(item.alias);
    inventory.set(item.id, previous);
  }
  return inventory;
}

export function productionProjection(pkg, lock) {
  assert.equal(pkg.name, lock.name, 'Package and lock names disagree');
  assert.equal(pkg.version, lock.version, 'Package and lock versions disagree');
  assert.equal(
    pkg.workspaces,
    undefined,
    'Workspace runtime SBOM needs an explicit inventory policy',
  );
  expectedInventory(lock); // Validate before allowing npm to interpret projected paths.
  const projectedPkg = structuredClone(pkg);
  const projectedLock = structuredClone(lock);
  delete projectedPkg.devDependencies;
  delete projectedLock.packages[''].devDependencies;
  projectedLock.packages = Object.fromEntries([
    ['', projectedLock.packages['']],
    ...productionEntries(projectedLock),
  ]);
  return { pkg: projectedPkg, lock: projectedLock };
}

function validateComponents(components, inventory) {
  assert.ok(Array.isArray(components), 'SBOM components must be an array');
  const observed = new Set();
  for (const component of components) {
    const item = inventory.get(component['bom-ref']);
    assert.ok(item, 'Unexpected production SBOM component identity');
    assert.equal(component.version, item.version, 'Production SBOM version identity mismatch');
    assert.equal(component.purl, item.purl, 'Production SBOM purl identity mismatch');
    assert.ok(item.displays.has(component.name), 'Production SBOM display identity mismatch');
    assert.equal(component.type, 'library', 'Production dependency must be a library');
    assert.deepEqual(
      component.hashes,
      [{ alg: 'SHA-512', content: item.sha512 }],
      'Production SBOM SHA-512 mismatch',
    );
    assert.ok(!observed.has(item.id), 'Duplicate production SBOM component');
    observed.add(item.id);
  }
  assert.deepEqual(
    [...observed].sort(),
    [...inventory.keys()].sort(),
    'Incomplete production SBOM inventory',
  );
}

function validateRelationships(sbom, inventory, root) {
  const expected = new Set([root, ...inventory.keys()]);
  assert.ok(Array.isArray(sbom.dependencies), 'SBOM dependency relationships are missing');
  const observed = new Set();
  for (const relationship of sbom.dependencies) {
    assert.ok(expected.has(relationship.ref), 'Unexpected SBOM dependency relationship');
    assert.ok(!observed.has(relationship.ref), 'Duplicate SBOM dependency relationship');
    observed.add(relationship.ref);
    assert.ok(Array.isArray(relationship.dependsOn), 'Malformed SBOM relationship');
    assert.equal(new Set(relationship.dependsOn).size, relationship.dependsOn.length);
    assert.ok(
      relationship.dependsOn.every((ref) => expected.has(ref)),
      'Dangling SBOM relationship',
    );
  }
  assert.deepEqual([...observed].sort(), [...expected].sort(), 'Incomplete SBOM relationships');
}

export function validateProductionInventory(sbom, lock) {
  validateSbomSchema(sbom);
  assert.equal(sbom.bomFormat, 'CycloneDX', 'Expected native npm CycloneDX output');
  const inventory = expectedInventory(lock);
  validateComponents(sbom.components, inventory);
  const root = `${lock.name}@${lock.version}`;
  assert.equal(
    sbom.metadata?.component?.['bom-ref'],
    root,
    'Production SBOM application identity mismatch',
  );
  validateRelationships(sbom, inventory, root);
}

export async function productionSbom(root, { execute = runNpm } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const projection = productionProjection(pkg, lock);
  const temporary = await mkdtemp(join(tmpdir(), 'mp3-production-sbom-'));
  try {
    await writeFile(join(temporary, 'package.json'), JSON.stringify(projection.pkg));
    await writeFile(join(temporary, 'package-lock.json'), JSON.stringify(projection.lock));
    // npm11's :not(.dev) excludes shared prod/dev ancestry, even when lock dev is false.
    // Generate from an exact production projection; never alter the archive's original inputs.
    // https://github.com/npm/cli/blob/v11.19.0/lib/commands/sbom.js
    const result = await execute(
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
        join(temporary, 'cache'),
      ],
      { cwd: temporary },
    );
    const sbom = JSON.parse(result.stdout);
    validateProductionInventory(sbom, lock);
    const listing = await execute(
      [
        'ls',
        '--all',
        '--long',
        '--json',
        '--package-lock-only',
        '--omit=dev',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--cache',
        join(temporary, 'cache'),
      ],
      { cwd: temporary },
    );
    validateResolvedGraph(sbom, projection.lock, JSON.parse(listing.stdout), temporary);
    return sbom;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
