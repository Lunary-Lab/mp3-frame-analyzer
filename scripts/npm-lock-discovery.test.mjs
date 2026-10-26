import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyRepositoryNpmLocks } from './verify-npm-lock.mjs';
import { installRuntimeDependencies } from './verify-artifact.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
async function writeProject(directory, data = lock) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify(data));
}

test('new manifests and locks are discovered; orphan, shrinkwrap and symlink inputs fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-npm-lock-discovery-'));
  try {
    await writeProject(directory);
    await assert.rejects(verifyRepositoryNpmLocks(directory));
    execFileSync('git', ['init', '--quiet', directory]);
    assert.equal((await verifyRepositoryNpmLocks(directory)).locks, 1);
    await writeProject(join(directory, 'new project'));
    assert.equal((await verifyRepositoryNpmLocks(directory)).locks, 2);
    const broken = structuredClone(lock);
    delete broken.packages['node_modules/fastify'].integrity;
    await writeProject(join(directory, 'new project'), broken);
    await assert.rejects(verifyRepositoryNpmLocks(directory), /SHA-512/);
    await writeProject(join(directory, 'new project'));
    execFileSync('git', ['-C', directory, 'add', 'new project']);
    await writeFile(join(directory, '.gitignore'), 'new project/\n');
    assert.equal((await verifyRepositoryNpmLocks(directory)).locks, 2);
    await writeFile(join(directory, 'npm-shrinkwrap.json'), '{}');
    await assert.rejects(verifyRepositoryNpmLocks(directory), /override/);
    await writeFile(join(directory, '.gitignore'), 'new project/\nnpm-shrinkwrap.json\n');
    await assert.rejects(verifyRepositoryNpmLocks(directory), /override/);
    await rm(join(directory, 'npm-shrinkwrap.json'));
    await rm(join(directory, 'new project/package-lock.json'));
    await assert.rejects(verifyRepositoryNpmLocks(directory));
    await symlink('../package-lock.json', join(directory, 'new project/package-lock.json'));
    await assert.rejects(verifyRepositoryNpmLocks(directory), /regular package file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every npm ci acquisition runs preflight first with native source flags', async () => {
  const files = [
    '.github/actions/setup-project/action.yml',
    '.github/workflows/dependency-audit.yml',
    '.github/workflows/fuzz.yml',
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const lines = source.split('\n').map((line) => line.trim());
    const index = lines.indexOf('node scripts/verify-npm-lock.mjs');
    assert.ok(index > -1);
    const command = [
      'npm ci --ignore-scripts --no-audit --no-fund',
      '--registry=https://registry.npmjs.org --replace-registry-host=never',
    ].join(' ');
    assert.equal(lines[index + 1], command);
  }
});

test('a failed preflight stops the actual install block before npm can execute', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-npm-preflight-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    await writeProject(directory, { ...lock, packages: {} });
    const marker = join(directory, 'npm-called');
    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, 'bin/npm'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const source = await readFile(
      new URL('../.github/actions/setup-project/action.yml', import.meta.url),
      'utf8',
    );
    const block = source.slice(source.lastIndexOf('      run: |') + '      run: |'.length).trim();
    const command = block.replace(
      'scripts/verify-npm-lock.mjs',
      resolve('scripts/verify-npm-lock.mjs'),
    );
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command],
      {
        cwd: directory,
        env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}` },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm integrity policy failed/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    for (const kind of ['shrinkwrap', 'override']) {
      const changedManifest = structuredClone(manifest);
      const changedLock = structuredClone(lock);
      if (kind === 'shrinkwrap') changedLock.packages['node_modules/fastify'].hasShrinkwrap = true;
      else changedManifest.overrides = { fastify: { child: 'file:../unhashed.tgz' } };
      await writeProject(directory, changedLock);
      await writeFile(join(directory, 'package.json'), JSON.stringify(changedManifest));
      const rejected = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
        cwd: directory,
        env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      assert.notEqual(rejected.status, 0, kind);
      assert.match(rejected.stderr, /npm integrity policy failed/);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generated runtime installs recheck the same policy before npm and preserve native source flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-runtime-policy-'));
  const previous = process.env.npm_execpath;
  try {
    const marker = join(directory, 'npm-arguments.json');
    const fake = join(directory, 'npm-cli.mjs');
    await writeFile(
      fake,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));`,
    );
    process.env.npm_execpath = fake;
    const broken = structuredClone(lock);
    broken.packages['node_modules/fastify'].hasShrinkwrap = true;
    await assert.rejects(installRuntimeDependencies(manifest, broken, directory), /hasShrinkwrap/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await installRuntimeDependencies(manifest, lock, directory);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), [
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      '--replace-registry-host=never',
    ]);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
