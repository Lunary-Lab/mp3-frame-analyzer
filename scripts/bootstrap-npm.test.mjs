import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  bootstrapNpm,
  createNpmDirectory,
  githubBootstrapOptions,
  downloadNpm,
  npmRelease,
  readBoundedArchive,
} from './bootstrap-npm.mjs';

test('only the two reviewed npm releases have authoritative SHA-512 pins', () => {
  for (const version of ['11.19.0', '11.9.0']) {
    const release = npmRelease(version);
    assert.equal(release.url, `https://registry.npmjs.org/npm/-/npm-${version}.tgz`);
    assert.match(release.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.ok(Object.isFrozen(release));
  }
  for (const value of ['latest', '11', '^11.19.0', '11.19.1', '__proto__', '', undefined])
    assert.throws(() => npmRelease(value), /reviewed npm version/);
});

test('downloads require the exact registry URL, HTTPS redirect refusal and a deadline', async () => {
  let requested = false;
  const request = (url, options) => {
    assert.equal(url, npmRelease('11.19.0').url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    requested = true;
    return { status: 200, body: [Buffer.from('not the reviewed npm archive')] };
  };
  await assert.rejects(downloadNpm('11.19.0', request), /SHA-512/);
  assert.equal(requested, true);
  await assert.rejects(
    downloadNpm('11.9.0', () => ({ status: 404 })),
    /download failed/,
  );
  await assert.rejects(
    downloadNpm('11.9.0', () => Promise.reject(new Error('offline'))),
    /offline/,
  );
});

test('archive reads reject empty, missing and oversized streams', async () => {
  assert.deepEqual(
    await readBoundedArchive([Buffer.from('a'), Buffer.from('bc')]),
    Buffer.from('abc'),
  );
  await assert.rejects(readBoundedArchive(null), /Missing npm archive/);
  await assert.rejects(readBoundedArchive([]), /Empty npm archive/);
  await assert.rejects(readBoundedArchive([Buffer.alloc(8 * 1024 * 1024 + 1)]), /size limit/);
});

test('untrusted archive bytes fail before extraction and leave no installed executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-npm-bootstrap-test-'));
  const archive = join(directory, 'npm.tgz');
  const bytes = Buffer.from('not a tar archive');
  try {
    await writeFile(archive, bytes);
    await assert.rejects(bootstrapNpm('11.19.0', { archive, temporaryRoot: directory }), /SHA-512/);
    assert.deepEqual(await readdir(directory), ['npm.tgz']);
    assert.deepEqual(await readFile(archive), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deleting the authoritative pin is rejected rather than deriving one from the response', async () => {
  const source = await readFile(new URL('./bootstrap-npm.mjs', import.meta.url), 'utf8');
  const missingPin = source
    .replace(npmRelease('11.19.0').integrity, '')
    .replace("import { isMain } from './release-utils.mjs';", 'const isMain = () => false;');
  assert.notEqual(missingPin, source);
  const mutant = await import(
    `data:text/javascript;base64,${Buffer.from(missingPin).toString('base64')}`
  );
  assert.throws(() => mutant.npmRelease('11.19.0'), /Missing or malformed npm SHA-512 pin/);
  await assert.rejects(mutant.downloadNpm('11.19.0'), /Missing or malformed npm SHA-512 pin/);
});

test('all CI npm bootstrap entry points use verified bundles, not mutable global installs', async () => {
  for (const file of [
    '../.github/actions/setup-project/action.yml',
    '../.github/workflows/dependency-audit.yml',
    '../.github/workflows/fuzz.yml',
  ]) {
    const workflow = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(workflow, /node scripts\/bootstrap-npm\.mjs /);
    assert.doesNotMatch(workflow, /npm (?:install|i|add)\s+--global/);
    assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
  }
});

test('the documented bootstrap fails closed without changing PATH or running unverified npm', async () => {
  const docs = await readFile(new URL('../docs/security.md', import.meta.url), 'utf8');
  const section = docs.slice(docs.indexOf('## npm bootstrap integrity'));
  const example = section.match(/```bash\n([\s\S]*?)\n```/);
  assert.ok(example, 'Missing documented local bootstrap command');
  const result = spawnSync(
    'bash',
    [
      '-c',
      `original_path="$PATH"
node() { return 73; }
npm() { printf 'UNVERIFIED_NPM_EXECUTED\\n'; }
${example[1]}
status=$?
[ "$PATH" = "$original_path" ] || exit 74
exit "$status"`,
    ],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 73);
  assert.equal(result.stdout, '');
});

test('Actions requires its absolute temporary root while local use stays isolated', () => {
  assert.deepEqual(githubBootstrapOptions({}), {});
  assert.deepEqual(
    githubBootstrapOptions({ GITHUB_ACTIONS: 'false', RUNNER_TEMP: 'relative' }),
    {},
  );
  const root = join(tmpdir(), 'runner root');
  assert.deepEqual(githubBootstrapOptions({ GITHUB_ACTIONS: 'true', RUNNER_TEMP: root }), {
    temporaryRoot: root,
    stable: true,
  });
  for (const RUNNER_TEMP of [undefined, '', 'relative', '/tmp/bad\nroot', '/tmp/bad:root']) {
    assert.throws(
      () => githubBootstrapOptions({ GITHUB_ACTIONS: 'true', RUNNER_TEMP }),
      /temporary root/,
    );
  }
});

test('stable bundle paths retain identity across clean jobs without trusting existing bytes', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mp3-npm-path-test-'));
  const options = { temporaryRoot, stable: true };
  try {
    const first = await createNpmDirectory('11.19.0', options);
    const marker = join(first, 'marker');
    await writeFile(marker, 'prior bytes');
    await assert.rejects(createNpmDirectory('11.19.0', options), { code: 'EEXIST' });
    assert.equal(await readFile(marker, 'utf8'), 'prior bytes');
    await rm(first, { recursive: true });
    const second = await createNpmDirectory('11.19.0', options);
    assert.equal(second, first);
    assert.notEqual(await createNpmDirectory('11.9.0', options), first);
    await rm(second, { recursive: true });
    await writeFile(second, 'existing file');
    await assert.rejects(createNpmDirectory('11.19.0', options), { code: 'EEXIST' });
    assert.equal(await readFile(second, 'utf8'), 'existing file');
    await rm(second);
    const target = join(temporaryRoot, 'outside-marker');
    await writeFile(target, 'do not follow or remove');
    await symlink(target, second);
    await assert.rejects(createNpmDirectory('11.19.0', options), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf8'), 'do not follow or remove');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('concurrent Actions bootstraps cannot share one extraction directory', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mp3-npm-exclusive-test-'));
  try {
    const results = await Promise.allSettled([
      createNpmDirectory('11.19.0', { temporaryRoot, stable: true }),
      createNpmDirectory('11.19.0', { temporaryRoot, stable: true }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason.code, 'EEXIST');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
