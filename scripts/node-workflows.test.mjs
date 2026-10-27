import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('project setup selects verified Node and npm before maintained cache-only restoration', async () => {
  const setup = await source('.github/actions/setup-project/action.yml');
  const node = setup.indexOf('uses: ./.github/actions/setup-node-verified');
  const npm = setup.indexOf('node scripts/bootstrap-npm.mjs');
  const cache = setup.indexOf('uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1');
  const install = setup.indexOf('npm ci --ignore-scripts --no-audit --no-fund');
  assert.ok(node >= 0 && node < npm && npm < cache && cache < install);
  assert.match(setup, /version: \$\{\{ inputs\.node \}\}/);
  assert.match(setup, /default: '24\.22\.1'/);
  assert.match(setup, /cache: npm\n\s+cache-dependency-path: package-lock\.json/);
  assert.doesNotMatch(setup, /node-version:|node-version-file:|check-latest:/);
  assert.equal(await source('.nvmrc'), '24.22.1\n');
});

test('all verified Node callers explicitly disable preload and mutable compile-cache settings', async () => {
  for (const name of ['ci', 'dependency-audit', 'fuzz', 'release-notes', 'main-policy-audit']) {
    const workflow = await source(`.github/workflows/${name}.yml`);
    const globalEnvironment = /^env:\n((?: {2}[^\n]*\n)+)/m.exec(workflow)?.[1];
    assert.ok(globalEnvironment, name);
    for (const setting of [
      "  NODE_OPTIONS: ''",
      "  NODE_PATH: ''",
      "  NODE_COMPILE_CACHE: ''",
      "  NODE_DISABLE_COMPILE_CACHE: '1'",
    ]) {
      assert.ok(globalEnvironment.split('\n').includes(setting), `${name}: ${setting}`);
    }
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-node-verified/, name);
    assert.doesNotMatch(workflow, /node-version:|node-version-file:/, name);
  }
  const action = await source('.github/actions/setup-node-verified/action.yml');
  assert.doesNotMatch(
    action,
    /GITHUB_ENV/,
    'GitHub forbids setting NODE_OPTIONS through GITHUB_ENV',
  );
});

test('compatibility retains stable major-named jobs with exact reviewed runtime versions', async () => {
  const ci = await source('.github/workflows/ci.yml');
  assert.match(ci, /- node: '26'\n\s+version: '26\.12\.1'\n\s+npm: '11\.19\.0'/);
  assert.match(ci, /- node: '24'\n\s+version: '24\.22\.1'\n\s+npm: '11\.9\.0'/);
  assert.match(ci, /node: \$\{\{ matrix\.version \}\}/);
  assert.match(ci, /name: Node \$\{\{ matrix\.node \}\} and npm/);
  assert.match(ci, /if: matrix\.node == '26'/);
});

test('extended fuzz cache restoration does not acquire another runtime or run bundled npm first', async () => {
  const fuzz = await source('.github/workflows/fuzz.yml');
  const verified = fuzz.indexOf('uses: ./.github/actions/setup-node-verified');
  const npm = fuzz.indexOf('node scripts/bootstrap-npm.mjs 11.19.0');
  const cache = fuzz.indexOf('uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1');
  assert.ok(verified >= 0 && verified < npm && npm < cache);
  assert.match(fuzz, /cache-dependency-path: package-lock\.json/);
});

test('metadata audit sparsely checks out its verified runtime bootstrap without adding dependencies', async () => {
  const audit = await source('.github/workflows/main-policy-audit.yml');
  for (const path of [
    'scripts/main-policy-audit*.mjs',
    'scripts/bootstrap-node.sh',
    '.github/actions/setup-node-verified/action.yml',
    '.github/security/node-archives.sha256',
  ]) {
    assert.ok(audit.includes(`            ${path}\n`), path);
  }
  assert.match(audit, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(audit, /npm ci|: write\b|persist-credentials: true/);
});
