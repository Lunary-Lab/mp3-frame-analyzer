import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  npmCommand,
  parseChecksums,
  releaseNames,
  validateArchiveEntries,
} from './release-utils.mjs';
import { validateVersionMetadata } from './verify-version.mjs';

const head = '0123456789abcdef0123456789abcdef01234567';

function metadata(version = '1.2.3') {
  return [
    { name: 'mp3-frame-analyzer', version },
    {
      name: 'mp3-frame-analyzer',
      version,
      packages: { '': { name: 'mp3-frame-analyzer', version } },
    },
    { '.': version },
  ];
}

test('release identity agrees across package, both lockfile roots, manifest, and tag', () => {
  assert.deepEqual(validateVersionMetadata(...metadata(), { tag: 'v1.2.3', gitHead: head }), {
    name: 'mp3-frame-analyzer',
    version: '1.2.3',
    tag: 'v1.2.3',
    sourceCommit: head,
  });
  for (const change of [
    (_pkg, lock) => {
      lock.version = '1.2.2';
    },
    (_pkg, lock) => {
      lock.packages[''].version = '1.2.2';
    },
    (_pkg, _lock, manifest) => {
      manifest['.'] = '1.2.2';
    },
  ]) {
    const values = metadata();
    change(...values);
    assert.throws(() => validateVersionMetadata(...values, { gitHead: head }), /must agree/);
  }
});

test('stable releases reject prereleases, build metadata, leading zeros, and mismatched tags', () => {
  for (const version of [
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-rc.1',
    '1.2.3+build',
    'v1.2.3',
    '1.2',
    '1.2.3\n',
  ]) {
    assert.throws(() => validateVersionMetadata(...metadata(version), { gitHead: head }), /stable/);
  }
  for (const tag of ['1.2.3', 'v1.2.4', 'v1.2.3-rc.1', 'v01.2.3', 'v1.2.3\n']) {
    assert.throws(
      () => validateVersionMetadata(...metadata(), { tag, gitHead: head }),
      /RELEASE_TAG/,
    );
  }
});

test('CI requires a supplied full source commit to match the checked-out HEAD', () => {
  assert.equal(
    validateVersionMetadata(...metadata(), {
      gitHead: head,
      sourceCommit: head.toUpperCase(),
      ci: true,
    }).sourceCommit,
    head,
  );
  assert.throws(
    () => validateVersionMetadata(...metadata(), { gitHead: head, sourceCommit: 'short' }),
    /40-character/,
  );
  assert.throws(
    () => validateVersionMetadata(...metadata(), { gitHead: head, sourceCommit: `${head}\n` }),
    /40-character/,
  );
  assert.throws(
    () => validateVersionMetadata(...metadata(), { gitHead: 'not-a-commit' }),
    /Git HEAD/,
  );
  const other = 'a'.repeat(40);
  assert.throws(
    () => validateVersionMetadata(...metadata(), { gitHead: head, sourceCommit: other, ci: true }),
    /does not match/,
  );
  assert.equal(
    validateVersionMetadata(...metadata(), { gitHead: head, sourceCommit: other, ci: false })
      .sourceCommit,
    other,
  );
});

test('checksums require exactly one entry for every published asset', () => {
  const names = releaseNames('1.2.3');
  const expected = [names.archive, names.sbom, names.manifest];
  const lines = expected.map((name, index) => `${String(index).repeat(64)}  ${name}`);
  assert.equal(parseChecksums(`${lines.join('\n')}\n`, expected).size, 3);
  assert.throws(() => parseChecksums(lines.slice(0, 2).join('\n'), expected), /incomplete/);
  assert.throws(() => parseChecksums([...lines, lines[0]].join('\n'), expected), /duplicate/);
  assert.throws(
    () => parseChecksums(`${lines.join('\n')}\n${'a'.repeat(64)}  extra.txt`, expected),
    /unexpected/,
  );
  assert.throws(() => parseChecksums('not a digest', expected), /invalid/);
});

test('runtime archive inventory excludes development content and requires boot files', () => {
  const { base } = releaseNames('1.2.3');
  const files = [
    '',
    'dist/',
    'dist/mp3/',
    'dist/server.js',
    'dist/mp3/count-frames.js',
    'package.json',
    'package-lock.json',
    'README.md',
    'RUNTIME.md',
    '.npmrc',
    'release-metadata.json',
  ].map((path) => `${base}/${path}`);
  assert.doesNotThrow(() => validateArchiveEntries(files, base));
  for (const extra of [
    'src/app.ts',
    'tests/example.test.ts',
    'node_modules/fastify.js',
    'dist/server.ts',
  ]) {
    assert.throws(() => validateArchiveEntries([...files, `${base}/${extra}`], base), /Unexpected/);
  }
  assert.throws(
    () =>
      validateArchiveEntries(
        files.filter((path) => !path.endsWith('/dist/server.js')),
        base,
      ),
    /missing/,
  );
  assert.throws(() => validateArchiveEntries([...files, files[0]], base), /Unexpected/);
  assert.throws(
    () =>
      validateArchiveEntries(
        files.map((path) => `other/${path}`),
        base,
      ),
    /Unexpected/,
  );
});

test('npm CLI paths with spaces remain one subprocess argument', () => {
  const args = ['ci', '--omit=dev', '--ignore-scripts'];
  assert.deepEqual(npmCommand(args, '/tmp/npm runtime/npm-cli.js'), [
    process.execPath,
    ['/tmp/npm runtime/npm-cli.js', ...args],
  ]);
  assert.deepEqual(npmCommand(args, ''), ['npm', args]);
});
