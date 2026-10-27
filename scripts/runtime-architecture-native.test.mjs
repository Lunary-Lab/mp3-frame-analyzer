import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectRuntime } from './runtime-architecture.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mp3-runtime-architecture-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'src'));
    for (const name of ['runtime-architecture.mjs', 'runtime-architecture-rule.mjs']) {
      await copyFile(join(sourceRoot, 'scripts', name), join(root, 'scripts', name));
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await symlink(join(sourceRoot, 'node_modules'), join(root, 'node_modules'));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function scan(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts/runtime-architecture.mjs'), ...args], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH, HOME: root, ESLINT_USE_FLAT_CONFIG: 'false' },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('real CLI covers hidden/untracked source and ignores config, ignore, cache and suppression files', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'src/clean.ts'), 'JSON.parse("{}");');
    const clean = scan(root);
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(JSON.parse(clean.stdout), { files: ['clean.ts'], findings: [] });
    await mkdir(join(root, 'src/.hidden'));
    await writeFile(join(root, 'src/.hidden/input.ts'), '/* eslint-disable */\neval("synthetic");');
    for (const [name, content] of [
      ['.eslintignore', '**/*'],
      ['.gitignore', 'src/'],
      ['.eslintcache', '{}'],
      ['eslint-suppressions.json', '{"src/.hidden/input.ts":{"no-eval":{"count":999}}}'],
      ['eslint.config.mjs', 'throw new Error("Project config must not run");'],
      ['.eslintrc.json', '{"root":true,"ignorePatterns":["**/*"]}'],
    ])
      await writeFile(join(root, name), content);
    const red = scan(root);
    assert.equal(red.status, 1, red.stderr);
    const report = JSON.parse(red.stdout);
    assert.deepEqual(report.files, ['.hidden/input.ts', 'clean.ts']);
    assert.ok(report.findings.some((finding) => finding.ruleId === 'no-eval'));
    assert.ok(report.findings.every((finding) => finding.path === '.hidden/input.ts'));
  });
});

test('real CLI rejects target/config/cache/ignore/suppression overrides', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'src/input.ts'), 'eval("synthetic");');
    for (const args of [
      ['src'],
      ['--config', 'other'],
      ['--cache'],
      ['--ignore-path', '.eslintignore'],
      ['--suppress-all'],
      ['--quiet'],
    ]) {
      const result = scan(root, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /accepts no overrides/);
    }
  });
});

test('real CLI fails closed for absent, empty, malformed, symlinked and unsupported source', async () => {
  await fixture(async (root) => {
    assert.notEqual(scan(root).status, 0, 'Empty source must not pass');
    await rm(join(root, 'src'), { recursive: true });
    assert.notEqual(scan(root).status, 0, 'Missing source must not pass');
    await mkdir(join(root, 'src'));
    const input = join(root, 'src/input.ts');
    await writeFile(input, 'const = ;');
    const malformed = scan(root);
    assert.equal(malformed.status, 1);
    assert.ok(JSON.parse(malformed.stdout).findings.some((finding) => finding.fatal));
    await rm(input);
    await symlink(join(root, 'package.json'), input);
    assert.notEqual(scan(root).status, 0, 'Symlinked source must not pass');
    await rm(input);
    await writeFile(join(root, 'src/input.txt'), 'eval("synthetic");');
    assert.notEqual(scan(root).status, 0, 'Unsupported source must not be silently skipped');
  });
});

test('native source reading fails rather than treating unreadable files as empty', async () => {
  await fixture(async (root) => {
    const input = join(root, 'src/input.ts');
    await writeFile(input, 'eval("synthetic");');
    await chmod(input, 0);
    try {
      await assert.rejects(inspectRuntime(join(root, 'src')), /EACCES|EPERM/);
    } finally {
      await chmod(input, 0o600);
    }
  });
});

test('runtime discovery is explicit and scans current source without evaluating uploaded code', async () => {
  const result = await inspectRuntime(join(sourceRoot, 'src'));
  assert.ok(result.files.includes('server.ts'));
  assert.ok(result.files.includes('mp3/count-frames.ts'));
  assert.ok(result.files.length > 0);
  assert.deepEqual(result.findings, []);
  const scanner = await readFile(new URL('./runtime-architecture.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(scanner, /new ESLint|\.lintFiles\(|\.lintText\(/);
});
