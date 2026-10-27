import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { isMain } from './release-utils.mjs';

// Official registry SRI, independently checked against registry ECDSA signatures
// and the actual bundled tarballs on 2026-10-26. Versions do not override hashes.
const integrity = Object.freeze({
  '11.19.0':
    'sha512-SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==',
  '11.9.0':
    'sha512-BBZoU926FCypj4b7V7ElinxsWcy4Kss88UG3ejFYmKyq7Uc5XnT34Me2nEhgCOaL5qY4HvGu5aI92C4OYd7NaA==',
});
const execute = promisify(execFile);
const maximumBytes = 8 * 1024 * 1024;

export function npmRelease(version) {
  assert.ok(Object.hasOwn(integrity, version), 'Expected a reviewed npm version');
  const sri = integrity[version];
  assert.match(sri, /^sha512-[A-Za-z0-9+/]{86}==$/, 'Missing or malformed npm SHA-512 pin');
  return Object.freeze({
    url: `https://registry.npmjs.org/npm/-/npm-${version}.tgz`,
    integrity: sri,
  });
}

export async function readBoundedArchive(stream) {
  assert.ok(stream, 'Missing npm archive');
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    assert.ok(length <= maximumBytes, 'npm archive exceeds the size limit');
    chunks.push(chunk);
  }
  assert.ok(length > 0, 'Empty npm archive');
  return Buffer.concat(chunks, length);
}

function verifyArchive(version, bytes) {
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(actual, npmRelease(version).integrity, 'npm archive SHA-512 mismatch');
  return bytes;
}

export async function downloadNpm(version, request = fetch) {
  const release = npmRelease(version);
  const response = await request(release.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200, 'npm archive download failed');
  return verifyArchive(version, await readBoundedArchive(response.body));
}

function validateTemporaryRoot(root) {
  assert.ok(
    typeof root === 'string' &&
      isAbsolute(root) &&
      !/[\r\n\0]/.test(root) &&
      !root.includes(delimiter),
    'Expected an absolute, single-line temporary root without PATH separators',
  );
}

export function githubBootstrapOptions(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return {};
  validateTemporaryRoot(env.RUNNER_TEMP);
  return { temporaryRoot: env.RUNNER_TEMP, stable: true };
}

export async function createNpmDirectory(
  version,
  { temporaryRoot = tmpdir(), stable = false } = {},
) {
  const release = npmRelease(version);
  validateTemporaryRoot(temporaryRoot);
  if (!stable) return mkdtemp(join(temporaryRoot, 'mp3-verified-npm-'));
  const digest = Buffer.from(release.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const directory = join(temporaryRoot, `mp3-verified-npm-${version}-${digest}`);
  // Exclusive creation rejects any existing directory, file or symlink. Never
  // reuse or remove a prior extraction; the runner owns job-boundary cleanup.
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

/** Extract the verified, self-contained npm bundle without running an installer or lifecycle scripts. */
export async function bootstrapNpm(version, { archive, ...directoryOptions } = {}) {
  npmRelease(version);
  const bytes = archive
    ? verifyArchive(version, await readBoundedArchive(createReadStream(archive)))
    : await downloadNpm(version);
  const directory = await createNpmDirectory(version, directoryOptions);
  try {
    const tarball = join(directory, 'npm.tgz');
    await writeFile(tarball, bytes, { mode: 0o600, flag: 'wx' });
    await execute(
      'tar',
      ['-xzf', tarball, '-C', directory, '--no-same-owner', '--no-same-permissions'],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        // Keep the selected host GNU tar, not ambient tar/gzip command hooks.
        env: { PATH: process.env.PATH },
      },
    );
    const bin = join(directory, 'bin');
    await mkdir(bin);
    for (const name of ['npm', 'npx'])
      await symlink(join('..', 'package', 'bin', `${name}-cli.js`), join(bin, name));
    const result = await execute(
      process.execPath,
      [join(directory, 'package', 'bin', 'npm-cli.js'), '--version'],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        cwd: directory,
        env: { HOME: directory, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
      },
    );
    assert.equal(result.stdout.trim(), version, 'Verified npm bundle reports a different version');
    await rm(tarball);
    return bin;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (isMain(import.meta.url)) {
  assert.ok(
    process.argv.length === 3 || process.argv.length === 4,
    'Expected version and optional archive',
  );
  const bin = await bootstrapNpm(process.argv[2], {
    archive: process.argv[3],
    ...githubBootstrapOptions(),
  });
  if (process.env.GITHUB_PATH) await appendFile(process.env.GITHUB_PATH, `${bin}\n`);
  console.log(bin);
}
