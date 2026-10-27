import assert from 'node:assert/strict';

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function record(value) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected a package object',
  );
  return value;
}

function registrySpec(name, spec, exact) {
  assert.match(name, packageName, 'Invalid package name');
  assert.equal(typeof spec, 'string', 'Dependency specification must be a string');
  let source = name;
  let version = spec;
  if (spec.startsWith('npm:')) {
    const at = spec.lastIndexOf('@');
    source = spec.slice(4, at);
    version = spec.slice(at + 1);
    assert.match(source, packageName, 'Invalid registry alias');
  }
  assert.ok(
    version.length > 0 && !/[:/\\]/.test(version),
    'Unsupported nonregistry dependency source',
  );
  if (exact) assert.match(version, exactVersion, 'Direct dependency versions must be exact');
  return { source, version };
}

function declarations(entry, aliases, exact) {
  record(entry);
  for (const field of [
    'bundleDependencies',
    'bundledDependencies',
    'inBundle',
    'link',
    'hasShrinkwrap',
  ])
    assert.ok(!(field in entry), `${field} requires a separately reviewed source-integrity policy`);
  for (const field of fields) {
    for (const [name, spec] of Object.entries(record(entry[field] ?? {}))) {
      const { source } = registrySpec(name, spec, exact);
      if (source === name) continue;
      assert.ok(
        !aliases.has(name) || aliases.get(name) === source,
        'Conflicting alias targets need explicit review',
      );
      aliases.set(name, source);
    }
  }
}

function requireRegistryOverrides(overrides) {
  for (const [name, value] of Object.entries(record(overrides ?? {}))) {
    assert.match(name, packageName, 'Override selectors must be plain registry package names');
    if (typeof value === 'string')
      assert.match(
        value,
        exactVersion,
        'Overrides support exact registry versions only; alternate sources need review',
      );
    else requireRegistryOverrides(record(value));
  }
}

function lockedPackage(path, entry, aliases) {
  const names = path.split('node_modules/');
  assert.equal(names.shift(), '', 'Package path must begin with node_modules/');
  const installed = names.pop();
  assert.ok(
    names.every((name) => name.endsWith('/') && packageName.test(name.slice(0, -1))),
    'Invalid nested package path',
  );
  assert.match(installed, packageName, 'Invalid installed package name');
  const source = aliases.get(installed) ?? installed;
  assert.equal(
    entry.name ?? installed,
    source,
    'Locked alias source does not match its declaration',
  );
  assert.match(entry.version, exactVersion, 'Locked package version must be exact');
  assert.equal(typeof entry.resolved, 'string', 'Every package needs an explicit resolved source');
  const url = new URL(entry.resolved);
  assert.equal(url.origin, 'https://registry.npmjs.org', 'Unsupported registry origin');
  const tarball = `${source.split('/').at(-1)}-${entry.version}.tgz`;
  assert.equal(
    entry.resolved,
    `https://registry.npmjs.org/${source}/-/${tarball}`,
    'Source/name/version mismatch',
  );
  assert.match(
    entry.integrity,
    /^sha512-[A-Za-z0-9+/]{86}==$/,
    'Every package needs full SHA-512 SRI',
  );
  const encoded = entry.integrity.slice(7);
  const digest = Buffer.from(encoded, 'base64');
  assert.equal(digest.length, 64, 'Invalid SHA-512 digest length');
  assert.equal(digest.toString('base64'), encoded, 'Noncanonical SHA-512 encoding');
}

/** Pre-install policy only: npm remains the dependency resolver and byte-integrity verifier. */
export function verifyNpmLock(manifest, lock) {
  record(manifest);
  record(lock);
  assert.equal(lock.lockfileVersion, 3, 'Only npm lockfile v3 is supported');
  assert.ok(!('dependencies' in lock), 'Legacy lock inventories require explicit review');
  const packages = record(lock.packages);
  const root = record(packages['']);
  assert.ok(
    !('workspaces' in manifest) && !('workspaces' in root),
    'Workspace roots require explicit review',
  );
  for (const field of ['name', 'version', ...fields])
    assert.deepEqual(root[field], manifest[field], `Manifest/lock mismatch: ${field}`);
  assert.equal(lock.name, manifest.name, 'Lock name differs from manifest');
  assert.equal(lock.version, manifest.version, 'Lock version differs from manifest');
  const aliases = new Map();
  declarations(manifest, aliases, true);
  requireRegistryOverrides(manifest.overrides);
  for (const entry of Object.values(packages)) declarations(entry, aliases, false);
  const entries = Object.entries(packages).filter(([path]) => path !== '');
  assert.ok(entries.length > 0, 'Dependency lock cannot be empty');
  for (const [path, entry] of entries) lockedPackage(path, entry, aliases);
  for (const field of fields) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const entry = packages[`node_modules/${name}`];
      assert.ok(entry, `Direct dependency missing from lock: ${name}`);
      const { source, version } = registrySpec(name, spec, true);
      assert.equal(entry.version, version, `Direct dependency version mismatch: ${name}`);
      assert.equal(entry.name ?? name, source, `Direct dependency alias mismatch: ${name}`);
    }
  }
  return entries.length;
}
