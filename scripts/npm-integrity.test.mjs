import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { npmCommand, runFile } from './release-utils.mjs';
import { verifyNpmLock } from './npm-lock-policy.mjs';

test('native offline npm verifies present SRI, but npm ci alone does not require approved sources or SRI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-npm-integrity-'));
  try {
    const payload = join(directory, 'payload', 'package');
    const project = join(directory, 'project');
    await mkdir(payload, { recursive: true });
    await mkdir(project);
    await writeFile(
      join(payload, 'package.json'),
      JSON.stringify({ name: 'synthetic', version: '1.0.0' }),
    );
    const archive = join(directory, 'synthetic.tgz');
    await runFile('tar', ['-czf', archive, '-C', join(directory, 'payload'), 'package']);
    const sri = `sha512-${createHash('sha512')
      .update(await readFile(archive))
      .digest('base64')}`;
    const manifest = {
      name: 'synthetic-project',
      version: '1.0.0',
      dependencies: { synthetic: `file:${archive}` },
    };
    const entry = { version: '1.0.0', resolved: `file:${archive}`, integrity: sri };
    const lock = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: { '': manifest, 'node_modules/synthetic': entry },
    };
    await writeFile(join(project, 'package.json'), JSON.stringify(manifest));
    const install = async () => {
      await writeFile(join(project, 'package-lock.json'), JSON.stringify(lock));
      const [binary, args] = npmCommand([
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--fetch-retries=0',
        '--cache',
        join(directory, 'cache'),
      ]);
      return spawnSync(binary, args, {
        cwd: project,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_OFFLINE: 'true' },
      });
    };
    assert.equal(
      (await install()).status,
      0,
      'A correct local archive and digest must install offline',
    );
    await access(join(project, 'node_modules/synthetic/package.json'));
    entry.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    const corrupted = await install();
    assert.notEqual(corrupted.status, 0);
    assert.match(corrupted.stderr, /EINTEGRITY/, 'Native npm must reject a substituted digest');
    delete entry.integrity;
    assert.equal((await install()).status, 0, 'npm ci alone permits this local, unhashed package');
    assert.throws(
      () => verifyNpmLock(manifest, lock),
      'Repository policy must reject what npm ci alone permits',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
