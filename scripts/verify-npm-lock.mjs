import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { verifyNpmLock } from './npm-lock-policy.mjs';
import { isMain } from './release-utils.mjs';

export async function verifyRepositoryNpmLocks(root) {
  const tracked = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  ).split('\0');
  const files = new Set(
    tracked.filter((file) => /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json)$/.test(file)),
  );
  assert.ok(
    files.has('package.json') && files.has('package-lock.json'),
    'Missing root npm source inventory',
  );
  for (const file of files) {
    assert.ok(
      !file.endsWith('npm-shrinkwrap.json'),
      'npm-shrinkwrap.json can override the reviewed lock; unsupported',
    );
    assert.ok((await lstat(join(root, file))).isFile(), `Expected a regular package file: ${file}`);
    assert.equal(
      await realpath(join(root, file)),
      resolve(root, file),
      `Symlinked package source: ${file}`,
    );
  }
  const read = async (file) => JSON.parse(await readFile(join(root, file), 'utf8'));
  let packages = 0;
  let locks = 0;
  for (const file of files) {
    const directory = dirname(file);
    const manifest = join(directory, 'package.json');
    const lock = join(directory, 'package-lock.json');
    assert.ok(files.has(manifest) && files.has(lock), `${directory}: missing manifest or lock`);
    if (file !== lock) continue;
    await assertNoShrinkwrap(join(root, directory, 'npm-shrinkwrap.json'));
    packages += verifyNpmLock(await read(manifest), await read(lock));
    locks += 1;
  }
  return { locks, packages };
}

async function assertNoShrinkwrap(file) {
  try {
    await lstat(file);
  } catch (error) {
    assert.equal(error.code, 'ENOENT', 'Cannot inspect active npm shrinkwrap path');
    return;
  }
  assert.fail('npm-shrinkwrap.json can override the reviewed lock, even if ignored; unsupported');
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await verifyRepositoryNpmLocks(process.cwd())));
  } catch (error) {
    console.error(`npm integrity policy failed: ${error.message}`);
    process.exitCode = 1;
  }
}
