import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeApplicationSbom } from './package-release.mjs';
import { validateArchiveEntries } from './release-utils.mjs';
import { validateVersionMetadata } from './verify-version.mjs';

const head = '0123456789abcdef0123456789abcdef01234567';
const otherHead = 'a'.repeat(40);
const identity = { name: 'mp3-frame-analyzer', version: '2.0.0' };
const packageError = 'package.json must name mp3-frame-analyzer and use a stable X.Y.Z version';
const agreementError =
  'package.json, package-lock.json root, and release manifest versions must agree';
const tagError = 'RELEASE_TAG must be the exact stable vX.Y.Z tag matching package.json';
const headError = 'The checked-out Git HEAD must be a full commit SHA';
const sourceError = 'SOURCE_COMMIT must be a full 40-character hexadecimal commit SHA';
const ciError = 'SOURCE_COMMIT does not match the checked-out Git HEAD';

function validMetadata() {
  return [
    { ...identity },
    { ...identity, packages: { '': { ...identity } } },
    { '.': identity.version },
  ];
}

function invalidMetadata(change, options, message) {
  const values = validMetadata();
  change(...values);
  assert.throws(() => validateVersionMetadata(...values, options), { name: 'Error', message });
}

test('release metadata validation keeps error precedence and exact messages', () => {
  const invalidOptions = { tag: 'bad', gitHead: 'short', sourceCommit: 'short', ci: true };
  invalidMetadata(
    (pkg) => {
      pkg.name = 'other';
    },
    invalidOptions,
    packageError,
  );
  invalidMetadata(
    (_pkg, lock) => {
      lock.name = 'other';
    },
    invalidOptions,
    agreementError,
  );
  invalidMetadata(() => {}, invalidOptions, tagError);
  invalidMetadata(() => {}, { ...invalidOptions, tag: 'v2.0.0' }, headError);
  invalidMetadata(() => {}, { gitHead: head, sourceCommit: 'short', ci: true }, sourceError);
  invalidMetadata(() => {}, { gitHead: head, sourceCommit: otherHead, ci: true }, ciError);
  for (const value of [undefined, null, '', '2.0', '2.0.0 ', 2]) {
    invalidMetadata(
      (pkg) => {
        pkg.version = value;
      },
      { gitHead: head },
      packageError,
    );
  }
  for (const value of [undefined, null, {}, { '': null }, { '': {} }]) {
    invalidMetadata(
      (_pkg, lock) => {
        lock.packages = value;
      },
      { gitHead: head },
      agreementError,
    );
  }
});

test('release commit normalization retains local overrides and case-insensitive CI checks', () => {
  for (const options of [
    { gitHead: head.toUpperCase() },
    { gitHead: head, sourceCommit: head.toUpperCase(), ci: true },
    { gitHead: head, sourceCommit: otherHead, ci: false },
  ]) {
    assert.deepEqual(validateVersionMetadata(...validMetadata(), options), {
      ...identity,
      tag: 'v2.0.0',
      sourceCommit: (options.sourceCommit ?? options.gitHead).toLowerCase(),
    });
  }
});

function sbom() {
  return {
    bomFormat: 'CycloneDX',
    metadata: {
      component: {
        type: 'application',
        name: 'renamed-checkout',
        version: identity.version,
        'bom-ref': `${identity.name}@${identity.version}`,
        purl: `pkg:npm/${identity.name}@${identity.version}`,
      },
    },
    components: [{ name: 'untouched-dependency' }],
  };
}

test('SBOM validation mutates only the accepted root display name', () => {
  const value = sbom();
  const before = structuredClone(value);
  assert.equal(normalizeApplicationSbom(value, identity), value);
  before.metadata.component.name = identity.name;
  assert.deepEqual(value, before);
  for (const change of [
    (value) => {
      value.bomFormat = 'other';
    },
    (value) => {
      value.metadata = null;
    },
    (value) => {
      value.metadata.component = null;
    },
    (value) => {
      value.metadata.component.type = 'library';
    },
    (value) => {
      value.metadata.component.version = '1.0.0';
    },
    (value) => {
      value.metadata.component['bom-ref'] = 'other@2.0.0';
    },
    (value) => {
      value.metadata.component.purl = 'other';
    },
  ]) {
    const invalid = sbom();
    change(invalid);
    const unchanged = structuredClone(invalid);
    assert.throws(() => normalizeApplicationSbom(invalid, identity), {
      name: 'Error',
      message: 'npm returned an SBOM for a different package or version',
    });
    assert.deepEqual(invalid, unchanged);
  }
});

const base = 'mp3-frame-analyzer-2.0.0';
const requiredPaths = [
  'dist/server.js',
  'package.json',
  'package-lock.json',
  'README.md',
  'RUNTIME.md',
  '.npmrc',
  'release-metadata.json',
];
const archive = requiredPaths.map((path) => `${base}/${path}`);

test('archive validation preserves member, directory, file and missing-inventory failures', () => {
  assert.doesNotThrow(() =>
    validateArchiveEntries(
      [
        `${base}/`,
        `${base}/dist/`,
        `${base}/dist/sub_dir-2/`,
        `${base}/dist/sub_dir-2/child.file.js`,
        ...archive,
      ],
      base,
    ),
  );
  for (const [entry, category] of [
    ['other/dist/server.js', 'member'],
    [`${base}/dist/../server.js`, 'member'],
    [`${base}/dist/./server.js`, 'member'],
    [`${base}/dist\\server.js`, 'member'],
    [`${base}/src/`, 'directory'],
    [`${base}/dist/dotted.name/`, 'directory'],
    [`${base}/dist//`, 'directory'],
    [`${base}/dist/server.ts`, 'runtime file'],
    [`${base}/dist//server.js`, 'runtime file'],
    [`${base}/package.json/`, 'directory'],
  ]) {
    const description = category === 'runtime file' ? category : `archive ${category}`;
    assert.throws(() => validateArchiveEntries([...archive, entry], base), {
      name: 'Error',
      message: `Unexpected ${description}: ${entry}`,
    });
  }
  assert.throws(() => validateArchiveEntries([...archive, archive[0]], base), {
    name: 'Error',
    message: `Unexpected archive member: ${archive[0]}`,
  });
  assert.throws(() => validateArchiveEntries([], base), {
    name: 'Error',
    message: `Runtime archive is missing: ${requiredPaths.join(', ')}`,
  });
});
