import assert from 'node:assert/strict';

export const TRIVY_VERSION = '0.76.1';
export const BLOCKING_SEVERITIES = ['HIGH', 'CRITICAL', 'UNKNOWN'];
const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function lockInventory(lock, production = false) {
  assert.equal(lock.lockfileVersion, 3, 'Expected npm lock-v3');
  assert.ok(lock.packages && Object.keys(lock.packages).length > 1, 'Empty package lock');
  const inventory = new Map();
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (path === '' || (production && pkg.dev === true)) continue;
    assert.match(path, /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+$/);
    assert.ok(!pkg.link && !pkg.inBundle, 'Linked/bundled dependency is not supported');
    const name = pkg.name ?? path.split('node_modules/').at(-1);
    assert.match(name, npmName, 'Invalid locked package name');
    assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'Not an exact version');
    const key = `${name}@${pkg.version}`;
    inventory.set(key, [...(inventory.get(key) ?? []), path]);
  }
  assert.ok(inventory.size > 0, 'No dependencies in requested scope');
  return inventory;
}

export function databaseEvidence(metadata, now = Date.now()) {
  assert.equal(metadata.Version, 2, 'Wrong vulnerability database schema');
  const updated = Date.parse(metadata.UpdatedAt);
  const next = Date.parse(metadata.NextUpdate);
  const downloaded = Date.parse(metadata.DownloadedAt);
  assert.ok(
    Number.isFinite(updated) && updated <= now + 300_000 && now - updated <= 86_400_000,
    'Stale or invalid vulnerability database',
  );
  assert.ok(Number.isFinite(next) && next > now && next > updated, 'Database refresh is overdue');
  assert.ok(
    Number.isFinite(downloaded) && Math.abs(now - downloaded) <= 600_000,
    'Database was not freshly downloaded for this invocation',
  );
  return {
    schema: metadata.Version,
    updatedAt: metadata.UpdatedAt,
    nextUpdate: metadata.NextUpdate,
  };
}

export function trivyFindings(report, expected, scope) {
  assert.equal(report.SchemaVersion, 2, 'Unsupported Trivy report');
  assert.equal(report.Trivy?.Version, TRIVY_VERSION, 'Unexpected scanner version');
  assert.equal(report.ArtifactType, 'filesystem', 'Wrong scanner target');
  assert.ok(
    Array.isArray(report.Results) && report.Results.length === 1,
    'Missing/extra scan result',
  );
  const result = report.Results[0];
  assert.equal(result.Target, 'package-lock.json', 'Wrong lockfile target');
  assert.equal(result.Class, 'lang-pkgs');
  assert.equal(result.Type, 'npm');
  assert.ok(Array.isArray(result.Packages) && result.Packages.length > 0, 'Missing inventory');
  const inventory = new Set(result.Packages.map((pkg) => `${pkg.Name}@${pkg.Version}`));
  assert.deepEqual(
    [...inventory].sort(),
    [...expected.keys()].sort(),
    'Incomplete dependency coverage',
  );
  assert.ok(result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities));
  return (result.Vulnerabilities ?? []).flatMap((finding) =>
    normalizeFinding(finding, expected, scope),
  );
}

function normalizeFinding(finding, inventory, scope) {
  const {
    VulnerabilityID: advisory,
    PkgName: name,
    InstalledVersion: version,
    Severity: severity,
  } = finding;
  assert.ok(
    [advisory, name, version].every((value) => typeof value === 'string' && value.length > 0),
  );
  assert.ok(
    ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity),
    'Malformed severity',
  );
  assert.ok(inventory.has(`${name}@${version}`), 'Finding outside scanned inventory');
  return inventory
    .get(`${name}@${version}`)
    .map((path) => ({ advisory, name, version, path, scope, severity }));
}
