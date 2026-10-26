import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVersionMetadata } from './verify-version.mjs';
import { smokeRuntime } from './release-smoke.mjs';
import { verifyNpmLock } from './npm-lock-policy.mjs';
import {
  isMain,
  parseChecksums,
  readJson,
  releaseNames,
  repositoryRoot,
  runFile,
  runNpm,
  sha256,
  validateArchiveEntries,
} from './release-utils.mjs';

async function verifyReleaseMetadata(output, names, expected) {
  const files = [names.archive, names.sbom, names.manifest];
  const checksums = parseChecksums(await readFile(join(output, 'SHA256SUMS'), 'utf8'), files);
  for (const name of files) {
    assert.equal(
      await sha256(join(output, name)),
      checksums.get(name),
      `Checksum mismatch: ${name}`,
    );
  }
  const metadata = await readJson(join(output, names.manifest));
  for (const key of ['name', 'version', 'tag', 'sourceCommit']) {
    assert.equal(metadata[key], expected[key], `Release manifest ${key} mismatch`);
  }
  return metadata;
}

export async function installRuntimeDependencies(pkg, lock, runtime) {
  verifyNpmLock(pkg, lock);
  await runNpm(
    [
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      '--replace-registry-host=never',
    ],
    { cwd: runtime, timeout: 180_000 },
  );
}

export async function verifyArtifact() {
  const expected = await loadVersionMetadata();
  const names = releaseNames(expected.version);
  const output = join(repositoryRoot, 'release');
  const metadata = await verifyReleaseMetadata(output, names, expected);
  const archive = join(output, names.archive);
  const listing = await runFile('tar', ['-tzf', archive]);
  validateArchiveEntries(listing.stdout.trimEnd().split('\n'), names.base);
  const verbose = await runFile('tar', ['-tvzf', archive]);
  assert.ok(
    verbose.stdout
      .trimEnd()
      .split('\n')
      .every((line) => /^[d-]/.test(line)),
    'Archive must contain only regular files and directories',
  );

  const temporary = await mkdtemp(join(tmpdir(), 'mp3-release-smoke-'));
  try {
    await runFile('tar', [
      '-xzf',
      archive,
      '-C',
      temporary,
      '--no-same-owner',
      '--no-same-permissions',
    ]);
    const runtime = join(temporary, names.base);
    assert.deepEqual(await readJson(join(runtime, 'release-metadata.json')), metadata);
    const pkg = await readJson(join(runtime, 'package.json'));
    const lock = await readJson(join(runtime, 'package-lock.json'));
    assert.equal(pkg.version, expected.version);
    assert.equal(lock.version, expected.version);
    assert.equal(lock.packages[''].version, expected.version);
    await installRuntimeDependencies(pkg, lock, runtime);
    const result = await smokeRuntime(runtime);
    console.log(
      JSON.stringify(
        { artifact: names.archive, ...metadata, verifiedWithNode: process.version, ...result },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) await verifyArtifact();
