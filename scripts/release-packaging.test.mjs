import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { repositoryRoot } from './release-utils.mjs';

const run = promisify(execFile);

test('release packaging works when the checkout directory differs from the package name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp3-renamed-checkout-'));
  try {
    for (const file of [
      'package.json',
      'package-lock.json',
      '.release-please-manifest.json',
      '.npmrc',
      'README.md',
      'docs/runtime.md',
      'scripts/package-release.mjs',
      'scripts/release-utils.mjs',
      'scripts/verify-version.mjs',
    ]) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await cp(join(repositoryRoot, file), join(root, file));
    }
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/server.js'), 'export {};\n');
    await run('git', ['init', '--quiet'], { cwd: root });
    await run('git', ['add', '.'], { cwd: root });
    await run(
      'git',
      [
        '-c',
        'user.name=Release test',
        '-c',
        'user.email=release-test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Fixture',
      ],
      { cwd: root },
    );
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await run(process.execPath, ['scripts/package-release.mjs'], {
      cwd: root,
      env: { ...process.env, SOURCE_COMMIT: head, RELEASE_TAG: 'v' + pkg.version },
      timeout: 30_000,
    });
    const sbom = JSON.parse(
      await readFile(join(root, 'release', pkg.name + '-' + pkg.version + '.cdx.json'), 'utf8'),
    );
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.equal(sbom.metadata.component.name, pkg.name);
    assert.equal(sbom.metadata.component.version, pkg.version);
    assert.equal(sbom.metadata.component['bom-ref'], pkg.name + '@' + pkg.version);
    assert.equal(sbom.metadata.component.purl, 'pkg:npm/' + pkg.name + '@' + pkg.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
