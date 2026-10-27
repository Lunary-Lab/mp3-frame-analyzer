import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { npmCommand, repositoryRoot } from './release-utils.mjs';
import { parse } from 'yaml';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'local-install-integrity-'));
  try {
    await cp(new URL('../.npmrc', import.meta.url), join(root, '.npmrc'));
    const dependency = join(root, 'dependency');
    await mkdir(dependency);
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({
        name: 'reviewed-local-fixture',
        version: '1.0.0',
        scripts: { postinstall: 'node install.cjs' },
      }),
    );
    await writeFile(
      join(dependency, 'install.cjs'),
      "require('node:fs').writeFileSync('lifecycle-ran','unexpected');\n",
    );
    const env = { ...process.env, npm_config_cache: join(root, 'cache') };
    delete env.npm_config_ignore_scripts;
    delete env.NPM_CONFIG_IGNORE_SCRIPTS;
    const npm = (args, cwd = root) => {
      const [command, commandArgs] = npmCommand(args);
      return spawnSync(command, commandArgs, { cwd, env, encoding: 'utf8', timeout: 30_000 });
    };
    const packed = npm(
      ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', root],
      dependency,
    );
    assert.equal(packed.status, 0, packed.stderr);
    const archive = JSON.parse(packed.stdout)[0].filename;
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'local-root-fixture',
        version: '1.0.0',
        private: true,
        dependencies: { 'reviewed-local-fixture': `file:${archive}` },
        scripts: {
          postinstall: 'node root-install.cjs',
          'hooks:install': 'node explicit-hook.cjs',
        },
      }),
    );
    await writeFile(
      join(root, 'root-install.cjs'),
      "require('node:fs').writeFileSync('root-lifecycle-ran','unexpected');\n",
    );
    await writeFile(
      join(root, 'explicit-hook.cjs'),
      "require('node:fs').writeFileSync('explicit-hook-ran','requested');\n",
    );
    const locked = npm([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
    ]);
    assert.equal(locked.status, 0, locked.stderr);
    await run({ root, npm });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('plain npm ci uses the repository default to skip root and dependency lifecycle execution', async () => {
  await fixture(async ({ root, npm }) => {
    const result = npm(['ci', '--offline', '--no-audit', '--no-fund']);
    assert.equal(result.status, 0, result.stderr);
    for (const file of [
      'root-lifecycle-ran',
      'node_modules/reviewed-local-fixture/lifecycle-ran',
    ]) {
      await assert.rejects(readFile(join(root, file)), { code: 'ENOENT' });
    }
    assert.equal(npm(['run', 'hooks:install', '--offline']).status, 0);
    assert.equal(await readFile(join(root, 'explicit-hook-ran'), 'utf8'), 'requested');
    // Positive control: these same harmless lifecycle scripts do execute when explicitly enabled.
    const enabled = npm(['ci', '--ignore-scripts=false', '--offline', '--no-audit', '--no-fund']);
    assert.equal(enabled.status, 0, enabled.stderr);
    for (const file of [
      'root-lifecycle-ran',
      'node_modules/reviewed-local-fixture/lifecycle-ran',
    ]) {
      assert.equal(await readFile(join(root, file), 'utf8'), 'unexpected');
    }
  });
});

test('staged formatter uses only installed locked bytes and fails without acquiring when absent', async () => {
  const config = parse(await readFile(new URL('../lefthook.yml', import.meta.url), 'utf8'));
  const command = config['pre-commit'].commands.format.run.replace(
    '{staged_files}',
    'fixture.json',
  );
  const root = await mkdtemp(join(tmpdir(), 'local-formatter-hook-'));
  try {
    const marker = join(root, 'acquisition-attempt');
    const bin = join(root, 'bin');
    await mkdir(bin);
    for (const executable of ['npx', 'npm']) {
      await writeFile(
        join(bin, executable),
        `#!/bin/sh\nprintf unexpected > '${marker}'\nexit 97\n`,
        { mode: 0o700 },
      );
    }
    await writeFile(join(root, 'fixture.json'), '{ "ok": true }\n');
    const invoke = () =>
      spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    assert.notEqual(invoke().status, 0);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await mkdir(join(root, 'node_modules'));
    await symlink(
      join(repositoryRoot, 'node_modules/prettier'),
      join(root, 'node_modules/prettier'),
      'dir',
    );
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /All matched files use Prettier code style/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
