import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { globalFingerprint, fingerprint } from './mutation-cache-inputs.mjs';
import { fixtureInputs } from './mutation-cache-fixture.mjs';
import { mutationWorkflowInput } from './mutation-workflow-inputs.mjs';
import { stringify } from 'yaml';

const workflowPath = '.github/workflows/ci.yml';
const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const snapshot = (source, extra = []) => fixtureInputs(new Map([[workflowPath, source], ...extra]));

test('unrelated SAST workflow, rule, fixture and policy-test edits retain compatibility', () => {
  const before = snapshot(ci, [
    ['.semgrep.yml', 'rules: []'],
    ['scripts/ci-workflow.test.mjs', "import assert from 'node:assert/strict';"],
  ]);
  const after = snapshot(ci.replace('--no-trace src', '--no-trace --disable-nosem src'), [
    ['.semgrep.yml', 'rules: [changed]'],
    ['scripts/ci-workflow.test.mjs', "import assert from 'node:assert/strict'; assert.ok(true);"],
    ['tests/semgrep/runtime-execution.ts.fixture', 'const fixture = true;'],
    ['docs/security.md', 'Updated SAST verification instructions'],
  ]);
  assert.notEqual(fingerprint(before), fingerprint(after));
  assert.equal(globalFingerprint(before), globalFingerprint(after));
});

test('an unrelated lint job command does not change mutation execution inputs', () => {
  const after = ci.replace('npm run lint', 'npm run lint && node scripts/verify-ci.mjs');
  assert.notEqual(ci, after);
  assert.equal(globalFingerprint(snapshot(ci)), globalFingerprint(snapshot(after)));
});

for (const [name, before, after] of [
  [
    'mutation command',
    'node scripts/run-mutations.mjs\n',
    'node scripts/run-mutations.mjs --full\n',
  ],
  ['direct prerequisite', 'npm run test:coverage', 'npm run test'],
  ['root environment', "NPM_CONFIG_UPDATE_NOTIFIER: 'false'", "NPM_CONFIG_UPDATE_NOTIFIER: 'true'"],
  [
    'mutation dependencies',
    'needs: [types, unit, tooling]',
    'needs: [types, unit, tooling, semgrep]',
  ],
  ['trigger', "cron: '23 5 * * 1'", "cron: '24 5 * * 1'"],
]) {
  test(`${name} still invalidates compatibility`, () => {
    const afterCi = ci.replace(before, after);
    assert.notEqual(ci, afterCi);
    assert.notEqual(globalFingerprint(snapshot(ci)), globalFingerprint(snapshot(afterCi)));
  });
}

const minimal = () => ({
  name: 'CI',
  on: ['push'],
  jobs: {
    prepare: { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'npm run build' }] },
    unit: { needs: 'prepare', 'runs-on': 'ubuntu-24.04', steps: [{ run: 'npm test' }] },
    mutation: { needs: ['unit'], 'runs-on': 'ubuntu-24.04', steps: [{ run: 'npm run mutation' }] },
    semgrep: { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'semgrep scan' }] },
  },
});
const key = (workflow) => globalFingerprint(snapshot(stringify(workflow)));

test('the complete transitive prerequisite closure is retained', () => {
  const before = minimal();
  const after = structuredClone(before);
  after.jobs.prepare.steps[0].run = 'npm run build -- --changed';
  assert.notEqual(key(before), key(after));
  const envelope = mutationWorkflowInput(stringify(before));
  assert.deepEqual(Object.keys(envelope.jobs), ['mutation', 'prepare', 'unit']);
  assert.deepEqual(envelope.jobs.prepare, before.jobs.prepare);
});

test('independent jobs may be added, renamed, removed or modified', () => {
  const before = minimal();
  const after = structuredClone(before);
  delete after.jobs.semgrep;
  after.jobs.newSast = { steps: [{ run: 'new-scanner' }], 'runs-on': 'ubuntu-24.04' };
  assert.equal(key(before), key(after));
});

for (const [field, value] of [
  ['name', 'new workflow name'],
  ['run-name', '${{ github.sha }}'],
  ['env', { SEED: 'changed' }],
  ['permissions', { contents: 'write' }],
  ['defaults', { run: { shell: 'bash', 'working-directory': 'changed' } }],
  ['concurrency', { group: 'changed' }],
  ['on', { workflow_call: { inputs: { seed: { type: 'number', default: 2 } } } }],
]) {
  test(`every root execution field remains bound: ${field}`, () => {
    const before = minimal();
    const after = { ...before, [field]: value };
    assert.notEqual(key(before), key(after));
  });
}

for (const [field, value] of [
  ['runs-on', 'self-hosted'],
  ['container', 'example/image'],
  ['environment', 'production'],
  ['env', { VALUE: 'new' }],
  ['permissions', { actions: 'write' }],
  ['defaults', { run: { shell: 'sh' } }],
  ['if', '${{ false }}'],
  ['timeout-minutes', 1],
  ['continue-on-error', true],
  ['strategy', { matrix: { node: [24, 26] } }],
  ['steps', [{ uses: './.github/actions/changed-setup' }]],
  ['services', { database: { image: 'example/database' } }],
  ['outputs', { value: '${{ steps.export.outputs.value }}' }],
  ['uses', './.github/workflows/changed.yml'],
]) {
  test(`the complete mutation job remains bound: ${field}`, () => {
    const before = minimal();
    const after = structuredClone(before);
    after.jobs.mutation[field] = value;
    assert.notEqual(key(before), key(after));
  });
}

test('only YAML presentation changes are normalized; step order and scalar types are retained', () => {
  const before = minimal();
  const source = stringify(before);
  const reordered = { jobs: before.jobs, on: before.on, name: before.name };
  assert.equal(key(before), key(reordered));
  assert.equal(
    globalFingerprint(snapshot(source)),
    globalFingerprint(snapshot(`# comment\n${source}`)),
  );
  before.jobs.mutation.env = { VALUE: 'false' };
  const after = structuredClone(before);
  after.jobs.mutation.env.VALUE = false;
  assert.notEqual(key(before), key(after));
  before.jobs.mutation.steps.push({ run: 'verify' });
  const reversed = structuredClone(before);
  reversed.jobs.mutation.steps.reverse();
  assert.notEqual(key(before), key(reversed));
});

for (const [name, source] of [
  ['duplicate root', 'on: [push]\non: [pull_request]\njobs: {}'],
  ['duplicate nested key', 'on: [push]\njobs: {mutation: {steps: [], steps: []}}'],
  ['custom tag', 'on: [push]\njobs: !custom {}'],
  ['standard explicit tag', 'on: [push]\njobs: !!map {}'],
  ['tag directive', '%TAG !e! tag:example.com,2020:\n---\non: [push]\njobs: {}'],
  ['version directive', '%YAML 1.1\n---\non: [push]\njobs: {}'],
  ['multiple documents', 'on: [push]\njobs: {}\n---\njobs: {}'],
  ['alias', 'on: [push]\njobs: {mutation: &m {}, semgrep: *m}'],
  ['cyclic alias', 'on: [push]\njobs: &m {mutation: *m}'],
  ['merge', 'on: [push]\njobs: {mutation: {<<: {steps: []}}}'],
  ['complex key', 'on: [push]\njobs: {? [mutation]: {}}'],
  ['nonfinite', 'on: [push]\njobs: {mutation: {timeout-minutes: .inf}}'],
  ['missing mutation', 'on: [push]\njobs: {unit: {}}'],
  ['unknown root field', 'on: [push]\nunrecognized: true\njobs: {mutation: {}}'],
  ['invalid YAML', 'on: [push\njobs: {mutation: {}}'],
  ['oversized source', `#${'x'.repeat(262144)}`],
]) {
  test(`unsupported workflow fails closed: ${name}`, () => {
    assert.throws(() => globalFingerprint(snapshot(source)), /Unsupported mutation workflow/);
  });
}

for (const value of [
  '${{ inputs.jobs }}',
  ['unit', '${{ inputs.job }}'],
  1,
  null,
  { job: 'unit' },
]) {
  test(`nonliteral prerequisite selection fails closed: ${JSON.stringify(value)}`, () => {
    const workflow = minimal();
    workflow.jobs.mutation.needs = value;
    assert.throws(() => key(workflow), /dynamic or invalid needs/);
  });
}

test('missing and cyclic prerequisites fail closed', () => {
  const missing = minimal();
  delete missing.jobs.prepare;
  assert.throws(() => key(missing), /missing or invalid job/);
  const cyclic = minimal();
  cyclic.jobs.prepare.needs = 'mutation';
  assert.throws(() => key(cyclic), /cyclic needs/);
});

test('deep prerequisite chains and nested mappings fail closed within explicit bounds', () => {
  const workflow = minimal();
  let previous = 'mutation';
  for (let index = 0; index < 65; index++) {
    const name = `prepare${index}`;
    workflow.jobs[previous].needs = name;
    workflow.jobs[name] = {};
    previous = name;
  }
  assert.throws(() => key(workflow), /needs depth/);
  const nested = minimal();
  let value = nested.jobs.mutation;
  for (let index = 0; index < 65; index++) value = value.next = {};
  assert.throws(() => key(nested), /mapping depth/);
});

test('workflow source bytes must authenticate against the complete input inventory', () => {
  const inputs = snapshot(ci);
  delete inputs.sources[workflowPath];
  assert.throws(() => globalFingerprint(inputs), /Unauthenticated mutation workflow/);
  inputs.sources[workflowPath] = `${ci}\n# unauthenticated`;
  assert.throws(() => globalFingerprint(inputs), /Unauthenticated mutation workflow/);
});

test('workflow rejection reasons never disclose YAML values or parser excerpts', () => {
  for (const source of [
    'on: [push]\njobs: {mutation: !PRIVATE_SENTINEL {}}',
    'on: [push]\njobs: {mutation: {needs: PRIVATE_SENTINEL}}',
    'on: [push]\njobs: {mutation: {env: {PRIVATE_SENTINEL: [}}}',
    'on: [push]\njobs: {mutation: {needs: "${{ secrets.PRIVATE_SENTINEL }}"}}',
  ]) {
    assert.throws(
      () => globalFingerprint(snapshot(source)),
      (error) => {
        assert.match(error.message, /^Unsupported mutation workflow:/);
        assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/);
        return true;
      },
    );
  }
});

for (const path of [
  '.github/actions/setup-project/action.yml',
  '.github/workflows/other.yml',
  'scripts/restore-mutation-baseline.mjs',
  'scripts/verify-encoder-discovery.mjs',
  'scripts/unreviewed-tool.mjs',
  'tests/fixtures/encoder.json',
  'tests/semgrep/not-a-fixture.json',
  'package-lock.json',
]) {
  test(`nonexempt setup, execution and resource bytes remain global: ${path}`, () => {
    assert.notEqual(
      globalFingerprint(snapshot(ci, [[path, 'before']])),
      globalFingerprint(snapshot(ci, [[path, 'after']])),
    );
  });
}
