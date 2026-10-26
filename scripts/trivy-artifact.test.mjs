import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packagedLock } from './trivy-artifact.mjs';
import { releaseNames, runFile, sha256 } from './release-utils.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'trivy-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = { name: 'mp3-frame-analyzer', version: '1.2.3' };
  const lock = {
    ...pkg,
    lockfileVersion: 3,
    packages: { '': pkg, 'node_modules/lodash': { version: '4.17.21' } },
  };
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  await writeFile(join(root, '.release-please-manifest.json'), '{".":"1.2.3"}');
  await runFile('git', ['init', '--quiet'], { cwd: root });
  await runFile(
    'git',
    [
      '-c',
      'user.name=Trivy test',
      '-c',
      'user.email=trivy-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Fixture',
    ],
    { cwd: root },
  );
  const sourceCommit = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const metadata = { ...pkg, tag: 'v1.2.3', sourceCommit };
  const names = releaseNames(pkg.version);
  const output = join(root, 'release');
  const runtime = join(root, 'stage', names.base);
  await mkdir(join(runtime, 'dist'), { recursive: true });
  await mkdir(output);
  for (const file of ['README.md', 'RUNTIME.md', '.npmrc', 'dist/server.js'])
    await writeFile(join(runtime, file), '');
  for (const [file, contents] of [
    ['package.json', pkg],
    ['package-lock.json', lock],
    ['release-metadata.json', metadata],
  ])
    await writeFile(join(runtime, file), JSON.stringify(contents));
  await writeFile(join(output, names.sbom), '{}');
  await writeFile(join(output, names.manifest), JSON.stringify(metadata));
  const value = { root, lock, metadata, names, output, runtime };
  await archive(value);
  return value;
}

async function checksums({ output, names }) {
  const lines = [];
  for (const name of [names.archive, names.sbom, names.manifest])
    lines.push(`${await sha256(join(output, name))}  ${name}`);
  await writeFile(join(output, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

async function archive(value) {
  const { root, names, output } = value;
  await runFile('tar', [
    '-czf',
    join(output, names.archive),
    '-C',
    join(root, 'stage'),
    names.base,
  ]);
  await checksums(value);
}

test('Trivy reads the exact checksummed lock from the expected source archive', async (t) => {
  const value = await fixture(t);
  const result = await packagedLock(value.lock, value.root);
  assert.equal(result.bytes, JSON.stringify(value.lock));
  assert.equal(result.archiveSha256, await sha256(join(value.output, value.names.archive)));
});

test('Trivy rejects missing, duplicate, extra and mismatched artifact checksum evidence', async (t) => {
  const value = await fixture(t);
  const path = join(value.output, 'SHA256SUMS');
  const original = await readFile(path, 'utf8');
  const lines = original.trim().split('\n');
  for (const invalid of [
    lines.slice(1).join('\n'),
    [...lines, lines[0]].join('\n'),
    `${original}${'a'.repeat(64)}  extra.txt\n`,
    original.replace(/^[a-f0-9]{64}/, '0'.repeat(64)),
  ]) {
    await writeFile(path, invalid);
    await assert.rejects(packagedLock(value.lock, value.root));
  }
  await rm(path);
  await assert.rejects(packagedLock(value.lock, value.root), /ENOENT/);
});

test('Trivy rejects retagged, wrong-source and changed-lock assets even with new checksums', async (t) => {
  const value = await fixture(t);
  for (const changed of [
    { name: 'other' },
    { version: '1.2.4' },
    { tag: 'v1.2.4' },
    { sourceCommit: 'a'.repeat(40) },
  ]) {
    await writeFile(
      join(value.output, value.names.manifest),
      JSON.stringify({ ...value.metadata, ...changed }),
    );
    await checksums(value);
    await assert.rejects(packagedLock(value.lock, value.root), /Wrong release identity/);
  }
  await writeFile(join(value.output, value.names.manifest), JSON.stringify(value.metadata));
  const changed = structuredClone(value.lock);
  changed.packages['node_modules/lodash'].version = '4.17.20';
  await writeFile(join(value.runtime, 'package-lock.json'), JSON.stringify(changed));
  await archive(value);
  await assert.rejects(packagedLock(value.lock, value.root), /Packaged dependency lock differs/);
});

test('Trivy rejects unsafe or incomplete archive inventory before reading the lock', async (t) => {
  const value = await fixture(t);
  await rm(join(value.runtime, 'dist/server.js'));
  await archive(value);
  await assert.rejects(packagedLock(value.lock, value.root), /missing/);
  await writeFile(join(value.runtime, 'dist/server.js'), '');
  await writeFile(join(value.runtime, 'unexpected.txt'), '');
  await archive(value);
  await assert.rejects(packagedLock(value.lock, value.root), /Unexpected runtime file/);
  await rm(join(value.runtime, 'unexpected.txt'));
  await rm(join(value.runtime, 'README.md'));
  await symlink('RUNTIME.md', join(value.runtime, 'README.md'));
  await archive(value);
  await assert.rejects(packagedLock(value.lock, value.root), /Non-regular archive entry/);
});

test('Trivy rejects missing, symlinked and oversized release assets', async (t) => {
  const value = await fixture(t);
  const path = join(value.output, value.names.sbom);
  await rm(path);
  await assert.rejects(packagedLock(value.lock, value.root), /ENOENT/);
  await symlink(join(value.output, value.names.manifest), path);
  await assert.rejects(packagedLock(value.lock, value.root), /Invalid release asset/);
  await rm(path);
  await writeFile(path, '');
  await truncate(path, 32 * 1024 * 1024);
  await assert.rejects(packagedLock(value.lock, value.root), /Invalid release asset/);
});
