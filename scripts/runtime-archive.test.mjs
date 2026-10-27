import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { repositoryRoot, runFile, sha256 } from './release-utils.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repositoryRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
  const pkg = { name: 'mp3-frame-analyzer', version: '1.2.3' };
  const lock = { ...pkg, lockfileVersion: 3, packages: { '': pkg } };
  for (const [file, value] of [
    ['package.json', pkg],
    ['package-lock.json', lock],
    ['.release-please-manifest.json', { '.': '1.2.3' }],
  ])
    await writeFile(join(root, file), JSON.stringify(value));
  await runFile('git', ['init', '--quiet'], { cwd: root });
  await runFile(
    'git',
    [
      '-c',
      'user.name=Archive test',
      '-c',
      'user.email=archive-test@example.invalid',
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
  const base = 'mp3-frame-analyzer-1.2.3';
  const runtime = join(root, 'stage', base);
  const output = join(root, 'release');
  await mkdir(join(runtime, 'dist'), { recursive: true });
  await mkdir(output);
  for (const file of ['README.md', 'RUNTIME.md', '.npmrc', 'dist/server.js'])
    await writeFile(join(runtime, file), '');
  for (const [file, value] of [
    ['package.json', pkg],
    ['package-lock.json', lock],
    ['release-metadata.json', { reached: 'validated archive extraction' }],
  ])
    await writeFile(join(runtime, file), JSON.stringify(value));
  await writeFile(join(output, `${base}.cdx.json`), '{}');
  await writeFile(join(output, `${base}.manifest.json`), JSON.stringify(metadata));
  const verifier = await import(pathToFileURL(join(root, 'scripts/verify-artifact.mjs')).href);
  const scanner = await import(pathToFileURL(join(root, 'scripts/trivy-artifact.mjs')).href);
  return {
    root,
    base,
    runtime,
    output,
    metadata,
    lock,
    verify: () => verifier.verifyArtifact(),
    scan: () => scanner.packagedLock(lock, root),
  };
}

async function archive(value) {
  const { root, base, output } = value;
  await runFile('tar', ['-czf', join(output, `${base}.tar.gz`), '-C', join(root, 'stage'), base]);
  const sums = [];
  for (const extension of ['tar.gz', 'cdx.json', 'manifest.json']) {
    const name = `${base}.${extension}`;
    sums.push(`${await sha256(join(output, name))}  ${name}`);
  }
  await writeFile(join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}

async function rejectsWithDiagnostic(operation, message) {
  await assert.rejects(operation, (error) => {
    // Node may append an assertion-value diff after the caller's diagnostic.
    assert.equal(error.message.split('\n')[0], message);
    return true;
  });
}

test('both artifact consumers accept the same complete regular-file archive preflight', async (t) => {
  const value = await fixture(t);
  await archive(value);
  // Deliberately stop the runtime verifier at its next independent metadata check:
  // no dependency installation or server launch is needed to characterize preflight.
  await assert.rejects(value.verify(), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.deepEqual(error.actual, { reached: 'validated archive extraction' });
    assert.deepEqual(error.expected, value.metadata);
    return true;
  });
  assert.equal((await value.scan()).bytes, JSON.stringify(value.lock));
});

for (const kind of ['symbolic link', 'hard link', 'FIFO']) {
  test(`both artifact consumers reject a real ${kind} with their own diagnostic`, async (t) => {
    const value = await fixture(t);
    const path = join(value.runtime, 'README.md');
    await rm(path);
    if (kind === 'symbolic link') await symlink('RUNTIME.md', path);
    else if (kind === 'hard link') await link(join(value.runtime, 'RUNTIME.md'), path);
    else await runFile('mkfifo', [path]);
    await archive(value);
    await assert.rejects(value.verify(), {
      code: 'ERR_ASSERTION',
      message: 'Archive must contain only regular files and directories',
    });
    await assert.rejects(value.scan(), {
      code: 'ERR_ASSERTION',
      message: 'Non-regular archive entry',
    });
  });
}

test('member inventory rejection precedes file-type rejection in both consumers', async (t) => {
  const value = await fixture(t);
  await rm(join(value.runtime, 'README.md'));
  await symlink('RUNTIME.md', join(value.runtime, 'README.md'));
  await writeFile(join(value.runtime, 'unexpected.txt'), '');
  await archive(value);
  for (const consume of [value.verify, value.scan]) {
    await assert.rejects(consume(), {
      message: `Unexpected runtime file: ${value.base}/unexpected.txt`,
    });
  }
});

test('both artifact consumers reject missing required members before extraction', async (t) => {
  const value = await fixture(t);
  await rm(join(value.runtime, 'dist/server.js'));
  await archive(value);
  for (const consume of [value.verify, value.scan]) {
    await assert.rejects(consume(), {
      message: 'Runtime archive is missing: dist/server.js',
    });
  }
});

test('each caller retains checksum and identity validation before archive preflight', async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.runtime, 'unexpected.txt'), '');
  await archive(value);
  await writeFile(join(value.output, `${value.base}.manifest.json`), '{}');
  await rejectsWithDiagnostic(value.verify(), `Checksum mismatch: ${value.base}.manifest.json`);
  await rejectsWithDiagnostic(value.scan(), 'Release checksum mismatch');
  await archive(value);
  await rejectsWithDiagnostic(value.verify(), 'Release manifest name mismatch');
  await rejectsWithDiagnostic(value.scan(), 'Wrong release identity');
});

test('both artifact consumers isolate inherited native tar checkpoint commands', async (t) => {
  const value = await fixture(t);
  await archive(value);
  const marker = join(value.root, 'tar-hook-ran');
  const hook = join(value.root, 'tar-hook');
  await writeFile(hook, `#!/bin/sh\nprintf observed > '${marker}'\n`, { mode: 0o700 });
  const previous = process.env.TAR_OPTIONS;
  process.env.TAR_OPTIONS = `--checkpoint=1 --checkpoint-action=exec=${hook}`;
  try {
    await assert.rejects(value.verify(), (error) => {
      assert.deepEqual(error.actual, { reached: 'validated archive extraction' });
      assert.deepEqual(error.expected, value.metadata);
      return true;
    });
    assert.equal((await value.scan()).bytes, JSON.stringify(value.lock));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.TAR_OPTIONS;
    else process.env.TAR_OPTIONS = previous;
  }
});

test('both artifact consumers ignore ambient gzip options without weakening preflight', async (t) => {
  const value = await fixture(t);
  await archive(value);
  const previous = process.env.GZIP;
  process.env.GZIP = '--not-a-supported-gzip-option';
  try {
    // Native positive control: the host decompressor really observes this poison.
    await assert.rejects(
      runFile('tar', ['-tzf', join(value.output, `${value.base}.tar.gz`)]),
      /gzip/,
    );
    await assert.rejects(value.verify(), (error) => {
      assert.deepEqual(error.actual, { reached: 'validated archive extraction' });
      assert.deepEqual(error.expected, value.metadata);
      return true;
    });
    assert.equal((await value.scan()).bytes, JSON.stringify(value.lock));
  } finally {
    if (previous === undefined) delete process.env.GZIP;
    else process.env.GZIP = previous;
  }
});
