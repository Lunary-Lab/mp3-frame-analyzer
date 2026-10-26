import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMain, sha256 } from './release-utils.mjs';
import { packagedLock } from './trivy-artifact.mjs';
import { nativeTrivyControls } from './trivy-native-controls.mjs';
import {
  BLOCKING_SEVERITIES,
  databaseEvidence,
  lockInventory,
  trivyFindings,
} from './trivy-policy.mjs';

export function trivyEnvironment(directory, environment = process.env) {
  const transport = [
    'PATH',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ];
  return {
    ...Object.fromEntries(
      transport.filter((key) => environment[key]).map((key) => [key, environment[key]]),
    ),
    HOME: directory,
    LANG: 'C.UTF-8',
    GOMEMLIMIT: '1GiB',
  };
}

export function trivyOptions(directory) {
  return [
    '--cache-dir',
    directory,
    '--disable-telemetry',
    '--skip-version-check',
    '--no-progress',
    '--config',
    '/dev/null',
    '--ignorefile',
    '/dev/null',
    '--timeout',
    '4m',
    '--db-repository',
    'ghcr.io/aquasecurity/trivy-db:2',
  ];
}

export function invokeTrivy(binary, args, directory) {
  const result = spawnSync(binary, args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: 300_000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
    env: trivyEnvironment(directory),
  });
  assert.equal(result.error, undefined, 'Scanner did not complete');
  assert.equal(result.status, 0, 'Scanner/database infrastructure failure');
  return result.stdout;
}

export function scanLock(binary, directory, production = false) {
  const options = [
    'fs',
    ...trivyOptions(directory),
    '--skip-db-update',
    '--skip-java-db-update',
    '--skip-check-update',
    '--skip-vex-repo-update',
    '--offline-scan',
    '--scanners',
    'vuln',
    '--list-all-pkgs',
    '--format',
    'json',
    '--exit-code',
    '0',
    '--parallel',
    '1',
  ];
  if (!production) options.push('--include-dev-deps');
  return JSON.parse(invokeTrivy(binary, [...options, 'package-lock.json'], directory));
}

export async function gate(binary, scope) {
  assert.ok(['full', 'release'].includes(scope), 'Expected full or release scope');
  const lockBytes = await readFile('package-lock.json', 'utf8');
  const lock = JSON.parse(lockBytes);
  const inventory = lockInventory(lock, scope === 'release');
  const artifact = scope === 'release' ? await packagedLock(lock) : { bytes: lockBytes };
  const directory = await mkdtemp(join(tmpdir(), 'mp3-trivy-'));
  try {
    await writeFile(join(directory, 'package-lock.json'), artifact.bytes, { mode: 0o600 });
    invokeTrivy(binary, ['fs', ...trivyOptions(directory), '--download-db-only'], directory);
    const metadata = JSON.parse(await readFile(join(directory, 'db/metadata.json'), 'utf8'));
    const database = {
      ...databaseEvidence(metadata),
      sha256: await sha256(join(directory, 'db/trivy.db')),
    };
    const findings = trivyFindings(
      scanLock(binary, directory, scope === 'release'),
      inventory,
      scope,
    );
    const blocked = findings.filter((finding) => BLOCKING_SEVERITIES.includes(finding.severity));
    const summary = {
      completed: true,
      accepted: blocked.length === 0,
      scanner: 'Trivy 0.76.1',
      scope,
      packages: inventory.size,
      lockPaths: [...inventory.values()].flat().length,
      lockSha256: await sha256(join(directory, 'package-lock.json')),
      archiveSha256: artifact.archiveSha256,
      database,
      blocked,
    };
    await nativeTrivyControls(binary, directory, scanLock);
    summary.nativeControls = true;
    // Only minimal provenance and blocking identities enter public logs; no raw report/artifact upload.
    console.log(JSON.stringify(summary));
    assert.equal(blocked.length, 0, 'Blocking HIGH/CRITICAL/UNKNOWN vulnerabilities');
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'Expected binary and scope');
    await gate(resolve(process.argv[2]), process.argv[3]);
  } catch {
    console.error(
      'Trivy gate did not pass; missing, stale, malformed or failed scanner evidence is blocking.',
    );
    process.exitCode = 1;
  }
}
