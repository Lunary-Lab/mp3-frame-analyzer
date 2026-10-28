import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const read = async (file) => parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const action = await read('../.github/actions/test-mutations/action.yml');
const { jobs } = await read('../.github/workflows/mutation.yml');
const steps = action.runs.steps;
const execution = steps.find((step) => step.id === 'mutation');
const routeGuard = steps.find(
  (step) => step.name === 'Require an explicit ordinary execution route',
);
const encoder = steps.find((step) =>
  step.run?.startsWith('node scripts/verify-encoder-discovery.mjs'),
);
const save = steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
const publish = steps.find((step) => step.with?.path === '.cache/mutation/native-baseline.json');
const diagnostics = steps.at(-1);

// Evaluate the actual YAML conditions over canonical fixture values. These fixtures model
// implicit success(), skipped ancestors and workflow cancellation, not a hosted scheduler.
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation
function condition(expression, context, successful = true, cancelled = false) {
  expression = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  successful &&= !cancelled;
  if (!/\b(?:always|success|failure|cancelled)\(/.test(expression) && !successful) return false;
  const program = expression.replace(
    /\b(?:inputs|steps|needs|github)\.[\w.-]+/g,
    (path) => `get('${path}')`,
  );
  return Boolean(
    runInNewContext(program, {
      get: (path) => path.split('.').reduce((value, key) => value?.[key], context) ?? '',
      always: () => true,
      success: () => successful,
      cancelled: () => cancelled,
      hashFiles: () => 'fixture-file-digest',
    }),
  );
}

function actionContext(route, overrides = {}) {
  return {
    inputs: { full: 'false', publish: 'true', 'parallel-fallback': 'true', ...overrides },
    steps: {
      mutation: { outputs: { route } },
      'pr-key': { outputs: { key: 'exact-key' } },
      'pr-cache': { outputs: { 'cache-hit': 'false' } },
    },
  };
}

function inlineStatus(step, env) {
  const program = step.run.split("<<'JS'\n")[1]?.split('\nJS')[0];
  assert.ok(program);
  return spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  }).status;
}

const needsOf = (job) => [jobs[job].needs ?? []].flat();
const ancestors = (job) => needsOf(job).flatMap((name) => [name, ...ancestors(name)]);
function selected(name, full, states, { expression = jobs[name].if, cancelled = false } = {}) {
  const needs = Object.fromEntries(needsOf(name).map((key) => [key, states[key]]));
  const successful = ancestors(name).every((key) => states[key]?.result === 'success');
  return condition(expression, { inputs: { full }, needs }, successful, cancelled);
}

const result = (state, route = '') => ({ result: state, outputs: { route } });

test('parallel routing is opt-in and transports exactly one runner output through action and job', () => {
  assert.equal(action.inputs['parallel-fallback'].default, 'false');
  assert.equal(action.outputs.route.value, '${{ steps.mutation.outputs.route }}');
  assert.equal(jobs.ordinary.outputs.route, '${{ steps.mutation.outputs.route }}');
  assert.equal(
    jobs.ordinary.steps.at(-1).with['parallel-fallback'],
    "${{ github.event_name == 'pull_request' }}",
  );
  assert.equal(execution.env.PARALLEL_FALLBACK, '${{ inputs.parallel-fallback }}');
  assert.equal(
    execution.run.trim(),
    [
      'if [ "$FORCE_FULL" = true ]; then',
      '  node scripts/run-mutations.mjs --full',
      '  echo \'route=native\' >> "$GITHUB_OUTPUT"',
      'elif [ "$PARALLEL_FALLBACK" = true ]; then',
      '  node scripts/run-mutations.mjs --parallel-fallback',
      'else',
      '  node scripts/run-mutations.mjs',
      '  echo \'route=native\' >> "$GITHUB_OUTPUT"',
      'fi',
    ].join('\n'),
  );
  assert.equal(execution['continue-on-error'], undefined);
  assert.equal(routeGuard['continue-on-error'], undefined);
  assert.deepEqual(routeGuard.env, { ROUTE: '${{ steps.mutation.outputs.route }}' });
  assert.ok(steps.indexOf(routeGuard) > steps.indexOf(execution));
  assert.ok(steps.indexOf(routeGuard) < steps.indexOf(encoder));
});

test('only PRs opt into fallback; main, nonfull manual and merge queue keep the native command', () => {
  const optIn = jobs.ordinary.steps.at(-1).with['parallel-fallback'];
  for (const event of ['pull_request', 'push', 'workflow_dispatch', 'merge_group']) {
    const enabled = condition(optIn, { github: { event_name: event } });
    assert.equal(enabled, event === 'pull_request');
    if (enabled) continue;
    const context = actionContext('native', { 'parallel-fallback': String(enabled) });
    assert.equal(condition(routeGuard.if, context), false);
    assert.equal(condition(encoder.if, context), true);
    assert.equal(selected('plan', false, { ordinary: result('success', 'native') }), false);
  }
});

test('missing and invalid routes fail the ordinary job instead of passing with all campaigns skipped', () => {
  for (const route of ['native', 'full-sharded'])
    assert.equal(inlineStatus(routeGuard, { ROUTE: route }), 0);
  for (const route of ['', 'unknown', 'NATIVE', 'FULL-SHARDED', 'native\n']) {
    assert.notEqual(inlineStatus(routeGuard, { ROUTE: route }), 0);
    const states = { ordinary: result('failure', route) };
    assert.equal(selected('plan', false, states), false);
  }
  assert.notEqual(inlineStatus(routeGuard, {}), 0);
});

test('only a successful native route checks encoders and promotes eligible cache results', () => {
  for (const route of ['native', 'full-sharded', '', 'unknown']) {
    const context = actionContext(route);
    assert.equal(condition(routeGuard.if, context), true);
    for (const step of [encoder, save, publish]) {
      assert.equal(condition(step.if, context), route === 'native');
      assert.equal(condition(step.if, context, false), false);
    }
    assert.equal(condition(diagnostics.if, context, false), true);
  }
  assert.equal(diagnostics.with.path, 'reports/mutation/');
  assert.equal(diagnostics['continue-on-error'], undefined);
  for (const overrides of [{ 'parallel-fallback': 'false' }, { full: 'true' }]) {
    const context = actionContext('', overrides);
    assert.equal(condition(routeGuard.if, context), false);
    for (const step of [encoder, save, publish]) assert.equal(condition(step.if, context), true);
  }
  assert.equal(condition(save.if, actionContext('native', { publish: 'false' })), true);
  assert.equal(condition(publish.if, actionContext('native', { publish: 'false' })), false);
  const cacheHit = actionContext('native');
  cacheHit.steps['pr-cache'].outputs['cache-hit'] = 'true';
  assert.equal(condition(save.if, cacheHit), false);
});

test('warm PR and ordinary main stay native, cold PR and explicit full select the matrix', () => {
  for (const [name, full, ordinary, launches] of [
    ['warm PR', false, result('success', 'native'), false],
    ['ordinary main', false, result('success', 'native'), false],
    ['cold PR', false, result('success', 'full-sharded'), true],
    ['explicit full', true, result('skipped'), true],
    ['warm failure', false, result('failure', 'native'), false],
    ['failed handoff', false, result('failure', 'full-sharded'), false],
    ['cancelled handoff', false, result('cancelled', 'full-sharded'), false],
    ['missing route', false, result('failure'), false],
  ]) {
    assert.equal(selected('ordinary', full, {}), !full, name);
    const states = { ordinary };
    assert.equal(selected('plan', full, states), launches, name);
    states.plan = result(launches ? 'success' : 'skipped');
    assert.equal(selected('shard', full, states), launches, name);
    states.shard = result(launches ? 'success' : 'skipped');
    assert.equal(selected('collect', full, states), launches, name);
  }
});

test('the collector runs and fails for every failed or cancelled selected full campaign', () => {
  for (const full of [false, true]) {
    for (const plan of ['success', 'failure', 'cancelled']) {
      for (const shard of ['success', 'failure', 'cancelled', 'skipped']) {
        const states = {
          ordinary: result(full ? 'skipped' : 'success', full ? '' : 'full-sharded'),
          plan: result(plan),
          shard: result(shard),
        };
        assert.equal(selected('shard', full, states), plan === 'success');
        assert.equal(selected('collect', full, states), true);
        const status = inlineStatus(jobs.collect.steps[0], {
          RESULTS: JSON.stringify({ plan: states.plan, shard: states.shard }),
        });
        assert.equal(status === 0, plan === 'success' && shard === 'success');
      }
    }
  }
});

test('status checks preserve explicit full skipped ancestors and failed-campaign collection', () => {
  const states = { ordinary: result('skipped'), plan: result('success'), shard: result('success') };
  for (const name of ['plan', 'shard', 'collect']) {
    assert.equal(selected(name, true, states), true);
    const expression = jobs[name].if.replace(/(?:!cancelled\(\)|always\(\)) && /, '');
    assert.equal(selected(name, true, states, { expression }), false);
  }
  states.ordinary = result('success', 'full-sharded');
  states.shard = result('failure');
  assert.equal(selected('collect', false, states), true);
  assert.equal(
    selected('collect', false, states, { expression: jobs.collect.if.replace('always() && ', '') }),
    false,
  );
});

test('workflow cancellation stops obsolete plans and shards while collection retains failure evidence', () => {
  for (const full of [false, true]) {
    const states = {
      ordinary: result(full ? 'skipped' : 'success', full ? '' : 'full-sharded'),
      plan: result('success'),
      shard: result('success'),
    };
    for (const name of ['plan', 'shard']) {
      assert.equal(selected(name, full, states), true);
      assert.equal(selected(name, full, states, { cancelled: true }), false);
      // Successful dependencies do not imply the workflow has escaped cancellation.
      const expression = jobs[name].if.replace('!cancelled()', 'always()');
      assert.equal(selected(name, full, states, { expression, cancelled: true }), true);
    }
    states.plan = result('cancelled');
    states.shard = result('skipped');
    assert.equal(selected('collect', full, states, { cancelled: true }), true);
    assert.notEqual(
      inlineStatus(jobs.collect.steps[0], {
        RESULTS: JSON.stringify({ plan: states.plan, shard: states.shard }),
      }),
      0,
    );
  }
});
