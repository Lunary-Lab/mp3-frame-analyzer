import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BLOCKING_SEVERITIES,
  databaseEvidence,
  lockInventory,
  trivyFindings,
} from './trivy-policy.mjs';
import { invokeTrivy, trivyEnvironment, trivyOptions } from './trivy-gate.mjs';

const lock = {
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/a': { version: '1.0.0' },
    'node_modules/a/node_modules/b': { version: '2.0.0', dev: true },
    'node_modules/alias': { name: 'actual', version: '3.0.0', optional: true },
    'node_modules/a/node_modules/alias': { name: 'actual', version: '3.0.0', optional: true },
  },
};
const report = () => ({
  SchemaVersion: 2,
  Trivy: { Version: '0.76.1' },
  ArtifactType: 'filesystem',
  Results: [
    {
      Target: 'package-lock.json',
      Class: 'lang-pkgs',
      Type: 'npm',
      Packages: [{ Name: 'a', Version: '1.0.0' }],
      Vulnerabilities: [],
    },
  ],
});
const finding = {
  VulnerabilityID: 'CVE-2099-1234',
  PkgName: 'a',
  InstalledVersion: '1.0.0',
  Severity: 'HIGH',
};
const expected = new Map([['a@1.0.0', ['node_modules/a']]]);
const inspect = (value) => trivyFindings(value, expected, 'full');

test('complete inventory retains all exact aliases, optional/platform and transitive paths', () => {
  assert.deepEqual([...lockInventory(lock).keys()], ['a@1.0.0', 'b@2.0.0', 'actual@3.0.0']);
  assert.equal(lockInventory(lock).get('actual@3.0.0').length, 2);
  assert.deepEqual([...lockInventory(lock, true).keys()], ['a@1.0.0', 'actual@3.0.0']);
  for (const mutation of [
    (value) => {
      value.lockfileVersion = 2;
    },
    (value) => {
      value.packages = {};
    },
    (value) => {
      value.packages['node_modules/a'].version = '^1.0.0';
    },
    (value) => {
      value.packages['node_modules/a'].link = true;
    },
    (value) => {
      value.packages['node_modules/a'].inBundle = true;
    },
  ]) {
    const value = structuredClone(lock);
    mutation(value);
    assert.throws(() => lockInventory(value));
  }
});

test('locked versions are exact SemVer, including prerelease plus build metadata', () => {
  const inventory = (version) => {
    const value = structuredClone(lock);
    value.packages['node_modules/a'].version = version;
    return lockInventory(value);
  };
  for (const version of ['0.0.0', '1.2.3-0', '1.2.3-beta.1+build.07', '1.2.3+001']) {
    assert.ok(inventory(version).has(`a@${version}`));
  }
  for (const version of [
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-beta.01',
    '1.2.3-..',
    '1.2.3+..',
    '1.2.3-',
    '1.2.3+',
    '1.2.3\n',
    '^1.2.3',
    'v1.2.3',
    null,
    123,
  ]) {
    assert.throws(() => inventory(version), undefined, `Accepted malformed version ${version}`);
  }
});

test('all HIGH/CRITICAL and unknown severity fail, including unfixed findings', () => {
  assert.deepEqual(inspect(report()), []);
  for (const severity of ['HIGH', 'CRITICAL', 'UNKNOWN', 'MEDIUM', 'LOW']) {
    const value = report();
    value.Results[0].Vulnerabilities = [{ ...finding, Severity: severity }];
    const findings = inspect(value);
    assert.equal(findings.length, 1);
    assert.equal(
      BLOCKING_SEVERITIES.includes(findings[0].severity),
      !['LOW', 'MEDIUM'].includes(severity),
    );
  }
});

test('a vulnerable alias version reports every original transitive lock path', () => {
  const inventory = lockInventory(lock);
  const value = report();
  value.Results[0].Packages = [
    { Name: 'a', Version: '1.0.0' },
    { Name: 'b', Version: '2.0.0' },
    { Name: 'actual', Version: '3.0.0' },
  ];
  value.Results[0].Vulnerabilities = [{ ...finding, PkgName: 'actual', InstalledVersion: '3.0.0' }];
  assert.deepEqual(
    trivyFindings(value, inventory, 'full').map(({ path }) => path),
    ['node_modules/alias', 'node_modules/a/node_modules/alias'],
  );
  value.Results[0].Packages.pop();
  assert.throws(() => trivyFindings(value, inventory, 'full'), /Incomplete dependency coverage/);
});

test('partial, malformed, extra target, wrong scanner and missing inventory fail closed', () => {
  for (const mutation of [
    (value) => {
      value.Results = [];
    },
    (value) => {
      value.Results.push(structuredClone(value.Results[0]));
    },
    (value) => {
      value.Results[0].Packages = [];
    },
    (value) => {
      value.Results[0].Packages.push({ Name: 'extra', Version: '1.0.0' });
    },
    (value) => {
      value.Results[0].Target = 'other-lock.json';
    },
    (value) => {
      value.SchemaVersion = 1;
    },
    (value) => {
      value.Trivy.Version = 'latest';
    },
    (value) => {
      value.ArtifactType = 'repository';
    },
    (value) => {
      value.Results[0].Class = 'os-pkgs';
    },
    (value) => {
      value.Results[0].Type = 'yarn';
    },
    (value) => {
      value.Results[0].Vulnerabilities = null;
    },
    (value) => {
      value.Results[0].Vulnerabilities = {};
    },
    (value) => {
      value.Results[0].Vulnerabilities = [{ ...finding, Severity: 'banana' }];
    },
    (value) => {
      value.Results[0].Vulnerabilities = [{ ...finding, VulnerabilityID: '' }];
    },
    (value) => {
      value.Results[0].Vulnerabilities = [{ ...finding, InstalledVersion: '1.0.1' }];
    },
    (value) => {
      value.Results[0].Vulnerabilities = [{ ...finding, PkgName: 'unscanned' }];
    },
  ]) {
    const value = report();
    mutation(value);
    assert.throws(() => inspect(value));
  }
});

test('DB schema, age, future timestamp, deadline and fresh-download identity are mandatory', () => {
  const now = Date.parse('2026-10-26T02:00:00Z');
  const metadata = {
    Version: 2,
    UpdatedAt: new Date(now - 3_600_000).toISOString(),
    NextUpdate: new Date(now + 3_600_000).toISOString(),
    DownloadedAt: new Date(now).toISOString(),
  };
  assert.equal(databaseEvidence(metadata, now).schema, 2);
  for (const changed of [
    { Version: 1 },
    { UpdatedAt: 'bad' },
    { UpdatedAt: new Date(now - 86_400_001).toISOString() },
    { UpdatedAt: new Date(now + 300_001).toISOString() },
    { NextUpdate: new Date(now - 1).toISOString() },
    { DownloadedAt: new Date(now - 600_001).toISOString() },
  ])
    assert.throws(() => databaseEvidence({ ...metadata, ...changed }, now));
});

test('ambient scanner config, credentials and telemetry overrides cannot enter the child', () => {
  assert.deepEqual(
    trivyEnvironment('/tmp/private', {
      PATH: '/usr/bin',
      TRIVY_SERVER: 'https://bad.example',
      TRIVY_DISABLE_TELEMETRY: 'false',
      GITHUB_TOKEN: 'synthetic',
      TRIVY_USERNAME: 'synthetic',
      NODE_OPTIONS: '--require=bad',
    }),
    { PATH: '/usr/bin', HOME: '/tmp/private', LANG: 'C.UTF-8', GOMEMLIMIT: '1GiB' },
  );
  const args = trivyOptions('/tmp/private');
  for (const flag of ['--disable-telemetry', '--skip-version-check', '--ignorefile', '--config']) {
    assert.ok(args.includes(flag));
  }
});

test('a native nonzero scanner exit and missing executable are blocking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trivy-failure-test-'));
  try {
    assert.throws(() => invokeTrivy(process.execPath, ['-e', 'process.exit(2)'], directory));
    assert.throws(() => invokeTrivy(join(directory, 'missing'), [], directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
