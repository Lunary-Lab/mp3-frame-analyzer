import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseChecksums, releaseNames, repositoryRoot, sha256 } from './release-utils.mjs';
import { validateProductionInventory } from './production-sbom.mjs';

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
      'scripts/production-sbom.mjs',
      'scripts/sbom-schema.mjs',
      'scripts/sbom-graph.mjs',
      'scripts/release-utils.mjs',
      'scripts/verify-version.mjs',
    ]) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await cp(join(repositoryRoot, file), join(root, file));
    }
    await cp(join(repositoryRoot, 'scripts/schemas'), join(root, 'scripts/schemas'), {
      recursive: true,
    });
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
    // Build-tool dependencies belong to the producer, never the runtime archive.
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const marker = join(root, 'tar-hook-ran');
    const hook = join(root, 'tar-hook');
    await writeFile(hook, `#!/bin/sh\nprintf observed > '${marker}'\n`, { mode: 0o700 });
    await run(process.execPath, ['scripts/package-release.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        SOURCE_COMMIT: head,
        RELEASE_TAG: 'v' + pkg.version,
        TAR_OPTIONS: `--checkpoint=1 --checkpoint-action=exec=${hook}`,
        GZIP: '--not-a-supported-gzip-option',
      },
      timeout: 30_000,
    });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const sbom = JSON.parse(
      await readFile(join(root, 'release', pkg.name + '-' + pkg.version + '.cdx.json'), 'utf8'),
    );
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.equal(sbom.metadata.component.name, pkg.name);
    assert.equal(sbom.metadata.component.version, pkg.version);
    assert.equal(sbom.metadata.component['bom-ref'], pkg.name + '@' + pkg.version);
    assert.equal(sbom.metadata.component.purl, 'pkg:npm/' + pkg.name + '@' + pkg.version);
    const originalLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    validateProductionInventory(sbom, originalLock);
    const names = releaseNames(pkg.version);
    const output = join(root, 'release');
    const artifacts = [names.archive, names.sbom, names.manifest];
    assert.deepEqual((await readdir(output)).sort(), [...artifacts, 'SHA256SUMS'].sort());
    const manifestText = await readFile(join(output, names.manifest), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(
      Object.keys(manifest).sort(),
      ['name', 'version', 'tag', 'sourceCommit', 'node', 'npm'].sort(),
    );
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.tag, `v${pkg.version}`);
    assert.equal(manifest.sourceCommit, head);
    assert.equal(manifest.node, process.version);
    assert.match(manifest.npm, /^\d+\.\d+\.\d+$/);
    const checksums = parseChecksums(await readFile(join(output, 'SHA256SUMS'), 'utf8'), artifacts);
    for (const name of artifacts)
      assert.equal(checksums.get(name), await sha256(join(output, name)));
    const archive = join(output, names.archive);
    const inventory = (await run('tar', ['-tzf', archive])).stdout.trim().split('\n');
    assert.deepEqual(
      inventory,
      [
        '',
        '.npmrc',
        'README.md',
        'RUNTIME.md',
        'dist/',
        'dist/server.js',
        'package-lock.json',
        'package.json',
        'release-metadata.json',
      ].map((path) => `${names.base}/${path}`),
    );
    const embedded = (await run('tar', ['-xOf', archive, `${names.base}/release-metadata.json`]))
      .stdout;
    assert.equal(embedded, manifestText);
    for (const file of [
      'package.json',
      'package-lock.json',
      'README.md',
      '.npmrc',
      'dist/server.js',
    ]) {
      assert.equal(
        (await run('tar', ['-xOf', archive, `${names.base}/${file}`])).stdout,
        await readFile(join(root, file), 'utf8'),
      );
    }
    assert.equal(
      (await run('tar', ['-xOf', archive, `${names.base}/RUNTIME.md`])).stdout,
      await readFile(join(root, 'docs/runtime.md'), 'utf8'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
