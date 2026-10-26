import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadVersionMetadata } from './verify-version.mjs';
import {
  parseChecksums,
  releaseNames,
  repositoryRoot,
  runFile,
  sha256,
  validateArchiveEntries,
} from './release-utils.mjs';

export async function packagedLock(lock, root = repositoryRoot) {
  const expected = await loadVersionMetadata(root);
  const output = join(root, 'release');
  const names = releaseNames(expected.version);
  const files = [names.archive, names.sbom, names.manifest];
  const checksums = parseChecksums(await readFile(join(output, 'SHA256SUMS'), 'utf8'), files);
  for (const name of files) {
    const path = join(output, name);
    const info = await lstat(path);
    assert.ok(info.isFile() && info.size < 32 * 1024 * 1024, 'Invalid release asset');
    assert.equal(await sha256(path), checksums.get(name), 'Release checksum mismatch');
  }
  const manifest = JSON.parse(await readFile(join(output, names.manifest), 'utf8'));
  for (const key of Object.keys(expected))
    assert.equal(manifest[key], expected[key], 'Wrong release identity');
  const archive = join(output, names.archive);
  const listing = await runFile('tar', ['-tzf', archive]);
  validateArchiveEntries(listing.stdout.trimEnd().split('\n'), names.base);
  const verbose = await runFile('tar', ['-tvzf', archive]);
  assert.ok(
    verbose.stdout
      .trimEnd()
      .split('\n')
      .every((line) => /^[d-]/.test(line)),
    'Non-regular archive entry',
  );
  const result = await runFile('tar', ['-xOf', archive, `${names.base}/package-lock.json`]);
  assert.deepEqual(
    JSON.parse(result.stdout),
    lock,
    'Packaged dependency lock differs from validated source',
  );
  return { bytes: result.stdout, archiveSha256: checksums.get(names.archive) };
}
