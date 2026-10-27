import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = async (file) => parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const ci = await read('../.github/workflows/ci.yml');
const workflow = await read('../.github/workflows/mutation.yml');
const { ordinary, plan, shard, collect } = workflow.jobs;
const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const upload = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9';
const download = 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333';

test('ordinary mutation keeps the existing native action and environment without matrix setup', () => {
  assert.deepEqual(workflow.env, ci.env);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.equal(ordinary.if, '${{ !inputs.full }}');
  assert.equal(ordinary.needs, undefined);
  assert.equal(ordinary.strategy, undefined);
  assert.equal(ordinary['runs-on'], 'ubuntu-24.04');
  assert.equal(ordinary['timeout-minutes'], 100);
  assert.deepEqual(ordinary.steps, [
    { uses: checkout, with: { ref: '${{ inputs.ref }}', 'persist-credentials': false } },
    { uses: './.github/actions/setup-project' },
    {
      uses: './.github/actions/test-mutations',
      with: { base: '${{ inputs.base }}', full: 'false', publish: '${{ inputs.publish }}' },
    },
  ]);
});

test('full partitions use a native dynamic matrix capped at eleven beside the pure campaign', () => {
  assert.equal(plan.if, 'inputs.full');
  assert.equal(shard.if, 'inputs.full');
  assert.equal(shard.needs, 'plan');
  assert.deepEqual(shard.strategy, {
    'fail-fast': false,
    'max-parallel': 11,
    matrix: '${{ fromJSON(needs.plan.outputs.matrix) }}',
  });
  assert.deepEqual(plan.outputs, { matrix: '${{ steps.plan.outputs.matrix }}' });
  assert.deepEqual(
    plan.steps.find((step) => step.uses === './.github/actions/setup-project').with,
    {
      install: 'false',
    },
  );
  const planning = plan.steps.find((step) => step.id === 'plan').run;
  assert.ok(planning.startsWith('matrix=$(node scripts/full-mutations.mjs plan)\n'));
  assert.ok(planning.includes('echo "matrix=$matrix" >> "$GITHUB_OUTPUT"'));
  assert.equal(shard['timeout-minutes'], 100);
  const execution = shard.steps.find((step) => step.run);
  assert.deepEqual(execution.env, { MUTATION_SHARD: '${{ matrix.shard }}' });
  assert.equal(execution.run, 'node scripts/full-mutations.mjs run "$MUTATION_SHARD"');
  assert.equal(ci.jobs['mutation-pure'].if, undefined);
  for (const job of [plan, shard, collect]) {
    assert.ok(job.steps.every((step) => step.uses !== './.github/actions/test-mutations'));
    assert.ok(job.steps.every((step) => !step.uses?.startsWith('actions/cache/')));
  }
});

test('all branches check out the exact caller source and keep pinned read-only dependencies', () => {
  const allowed = new Set([
    checkout,
    upload,
    download,
    './.github/actions/setup-project',
    './.github/actions/test-mutations',
  ]);
  for (const job of Object.values(workflow.jobs)) {
    const step = job.steps.find((step) => step.uses === checkout);
    assert.deepEqual(step.with, { ref: '${{ inputs.ref }}', 'persist-credentials': false });
    assert.equal(job.permissions, undefined);
    for (const step of job.steps) if (step.uses) assert.ok(allowed.has(step.uses));
  }
  assert.equal(ci.jobs.mutation.with.ref, '${{ inputs.ref || github.sha }}');
  assert.deepEqual(workflow.on.workflow_call.inputs, {
    ref: { type: 'string', required: true },
    base: { type: 'string', required: true },
    full: { type: 'boolean', required: true },
    publish: { type: 'boolean', required: true },
  });
});

test('collection requires successful dependencies before downloading current-attempt evidence', () => {
  assert.equal(collect.if, 'always() && inputs.full');
  assert.deepEqual(collect.needs, ['plan', 'shard']);
  const guard = collect.steps[0];
  assert.deepEqual(guard.env, { RESULTS: '${{ toJSON(needs) }}' });
  const program = guard.run.split("<<'JS'\n")[1]?.split('\nJS')[0];
  assert.ok(program);
  const run = (results) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      env: { RESULTS: JSON.stringify(results) },
      encoding: 'utf8',
      timeout: 5000,
    }).status;
  const good = () => ({ plan: { result: 'success' }, shard: { result: 'success' } });
  assert.equal(run(good()), 0);
  for (const name of ['plan', 'shard']) {
    for (const result of ['failure', 'cancelled', 'skipped', 'unknown'])
      assert.notEqual(run({ ...good(), [name]: { result } }), 0);
    const missing = good();
    delete missing[name];
    assert.notEqual(run(missing), 0);
  }
  for (const malformed of [null, [], {}, { ...good(), extra: { result: 'success' } }])
    assert.notEqual(run(malformed), 0);
  const fetch = collect.steps.find((step) => step.uses === download);
  assert.deepEqual(fetch.with, {
    pattern: 'full-parser-shard-${{ github.run_attempt }}-*',
    path: 'reports/mutation-shards/',
    'merge-multiple': false,
    'digest-mismatch': 'error',
  });
  assert.ok(
    collect.steps.some(
      (step) => step.run === 'node scripts/full-mutations.mjs collect reports/mutation-shards',
    ),
  );
});

test('raw shard evidence remains separate and missing uploads cannot pass', () => {
  const raw = shard.steps.find((step) => step.uses === upload);
  assert.equal(raw.if, 'always()');
  assert.deepEqual(raw.with, {
    name: 'full-parser-shard-${{ github.run_attempt }}-${{ matrix.shard }}',
    path: 'reports/mutation/',
    'if-no-files-found': 'error',
    'retention-days': 14,
  });
  const audit = collect.steps.find((step) => step.uses === upload);
  assert.equal(audit.if, 'always()');
  assert.equal(audit.with.name, 'full-parser-mutation-report-${{ github.run_attempt }}');
  assert.equal(audit.with.path, 'reports/mutation/');
  assert.equal(audit.with['if-no-files-found'], 'error');
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps) assert.equal(step['continue-on-error'], undefined);
});
