import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyNpmLock } from './npm-lock-policy.mjs';

const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const locked = (name, version = '1.2.3') => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
  integrity,
});
const fixture = () => {
  const manifest = { name: 'example', version: '1.0.0', dependencies: { ordinary: '1.2.3' } };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: { '': structuredClone(manifest), 'node_modules/ordinary': locked('ordinary') },
  };
  return { manifest, lock };
};

test('all current direct, transitive and optional registry packages pass without installed dependencies', async () => {
  const read = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url)));
  const lock = await read('package-lock.json');
  assert.equal(
    verifyNpmLock(await read('package.json'), lock),
    Object.keys(lock.packages).length - 1,
  );
});

test('every locked package requires canonical full SHA-512 and an exact canonical registry source', () => {
  for (const changed of [
    { integrity: undefined },
    { integrity: `sha1-${Buffer.alloc(20).toString('base64')}` },
    { integrity: 'sha512-AA==' },
    { integrity: `${integrity} sha1-AAAA` },
    { integrity: `${integrity.slice(0, -3)}B==` },
    { resolved: undefined },
    { resolved: 'http://registry.npmjs.org/ordinary/-/ordinary-1.2.3.tgz' },
    { resolved: 'https://example.com/ordinary/-/ordinary-1.2.3.tgz' },
    { resolved: 'https://registry.npmjs.org/ordinary/-/ordinary-9.9.9.tgz' },
    { resolved: 'https://registry.npmjs.org/evil/-/evil-1.2.3.tgz' },
    { resolved: 'https://registry.npmjs.org/ordinary/-/ordinary-1.2.3.tgz?download=true' },
    { version: '^1.2.3' },
    { version: '1.2.3/../../evil' },
    { link: true },
    { inBundle: true },
    { hasShrinkwrap: true },
  ]) {
    const { manifest, lock } = fixture();
    Object.assign(lock.packages['node_modules/ordinary'], changed);
    assert.throws(() => verifyNpmLock(manifest, lock), undefined, JSON.stringify(changed));
  }
});

test('nested overrides may select exact registry versions but never alternate source types', () => {
  const { manifest, lock } = fixture();
  manifest.overrides = { parent: { child: '1.2.3' } };
  assert.equal(verifyNpmLock(manifest, lock), 1);
  for (const spec of [
    'file:../child.tgz',
    'https://example.com/child.tgz',
    'git+https://example.com/repo',
    '$ordinary',
    'npm:other@1.2.3',
  ]) {
    manifest.overrides.parent.child = spec;
    assert.throws(() => verifyNpmLock(manifest, lock), undefined, spec);
  }
});

test('root metadata, exact direct versions and declared alias identities remain consistent', () => {
  const { manifest, lock } = fixture();
  manifest.devDependencies = { '@local/alias': 'npm:@upstream/actual@2.0.0' };
  lock.packages[''].devDependencies = structuredClone(manifest.devDependencies);
  lock.packages['node_modules/@local/alias'] = {
    ...locked('@upstream/actual', '2.0.0'),
    name: '@upstream/actual',
  };
  assert.equal(verifyNpmLock(manifest, lock), 2);
  for (const change of [
    (copy) => delete copy.packages['node_modules/ordinary'],
    (copy) => {
      copy.packages[''].dependencies.ordinary = '9.9.9';
    },
    (copy) => {
      copy.name = 'different';
    },
    (copy) => {
      copy.packages['node_modules/@local/alias'].name = 'evil';
    },
    (copy) => {
      delete copy.packages['node_modules/@local/alias'].name;
    },
    (copy) => {
      copy.packages['node_modules/@local/alias'].version = '3.0.0';
    },
  ]) {
    const copy = structuredClone(lock);
    change(copy);
    assert.throws(() => verifyNpmLock(manifest, copy));
  }
});

test('new entries cannot bypass the policy and unsupported ecosystem forms fail closed', () => {
  for (const source of [
    'file:../local',
    'workspace:*',
    'git+https://example.com/repo.git#main',
    'owner/repo',
  ]) {
    const { manifest, lock } = fixture();
    manifest.dependencies.ordinary = source;
    lock.packages[''].dependencies.ordinary = source;
    assert.throws(() => verifyNpmLock(manifest, lock));
  }
  for (const change of [
    (manifest) => {
      manifest.workspaces = ['packages/*'];
    },
    (manifest) => {
      manifest.bundleDependencies = ['ordinary'];
    },
    (manifest, lock) => {
      lock.lockfileVersion = 2;
    },
    (manifest, lock) => {
      lock.packages = { '': structuredClone(manifest) };
    },
    (manifest, lock) => {
      lock.packages['node_modules/new'] = { version: '1.0.0' };
    },
    (manifest, lock) => {
      lock.packages['../node_modules/escape'] = locked('escape');
    },
    (manifest, lock) => {
      lock.packages['node_modules/ordinary'].dependencies = { child: 'file:../child' };
    },
  ]) {
    const { manifest, lock } = fixture();
    change(manifest, lock);
    assert.throws(() => verifyNpmLock(manifest, lock));
  }
});

test('nested and optional entries are checked even when this platform would not install them', () => {
  const { manifest, lock } = fixture();
  lock.packages['node_modules/ordinary/node_modules/@scope/child'] = {
    ...locked('@scope/child'),
    optional: true,
    os: ['not-this-platform'],
  };
  assert.equal(verifyNpmLock(manifest, lock), 2);
  delete lock.packages['node_modules/ordinary/node_modules/@scope/child'].integrity;
  assert.throws(() => verifyNpmLock(manifest, lock));
});
