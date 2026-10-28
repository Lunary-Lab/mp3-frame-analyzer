import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = async (name) => parse(await read(`.github/workflows/${name}.yml`));
const release = await workflow('release-please');
const publisher = await workflow('publish-release');
const ci = await workflow('ci');
const title = await workflow('pr-title');

// These expressions use only string/boolean comparisons, shared by Actions and JS.
// This tests workflow routing, not a replacement implementation of Release Please.
function evaluate(expression, values) {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), values, {
    timeout: 100,
  });
}

function runInline(shell, env, execFileSync = () => assert.fail('Unexpected subprocess')) {
  const source = shell.match(/^node --input-type=module <<'JS'\n([\s\S]+)\nJS\s*$/)?.[1];
  assert.ok(source, 'Expected one inline Node script');
  const imports = source.match(/^import .+;$/gm) ?? [];
  for (const line of imports) {
    assert.ok(
      [
        "import assert from 'node:assert/strict';",
        "import { execFileSync } from 'node:child_process';",
      ].includes(line),
      `Unexpected dependency: ${line}`,
    );
  }
  // Execute the actual trusted workflow script with an isolated environment and
  // an inert subprocess boundary. No shell, network or filesystem mutation runs.
  const execute = new Function(
    'assert',
    'execFileSync',
    'process',
    source.replace(/^import .+;\n/gm, ''),
  );
  execute(assert, execFileSync, { env });
}

test('main pushes cannot rewrite proposals; only explicit preparation enables the native PR writer', () => {
  assert.deepEqual(Object.keys(release.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(release.on.push, { branches: ['main'] });
  const version = release.jobs.version;
  assert.equal(version.steps.length, 1, 'Keep a single native release writer without custom state');
  const action = version.steps[0];
  assert.equal(
    action.uses,
    'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
  );
  assert.equal(action.id, 'release');
  assert.equal(action.if, undefined);
  assert.equal(action.with['target-branch'], 'main');
  for (const [event, skipProposal] of [
    ['push', true],
    ['workflow_dispatch', false],
  ]) {
    const github = { event_name: event, ref: 'refs/heads/main' };
    assert.equal(evaluate(version.if, { github }), true);
    assert.equal(evaluate(action.with['skip-github-pull-request'], { github }), skipProposal);
    github.ref = 'refs/heads/feature';
    assert.equal(evaluate(version.if, { github }), false);
  }
  assert.deepEqual(release.concurrency, {
    group: 'release-please-main',
    'cancel-in-progress': false,
  });
});

test('merged release processing stays enabled independently of proposal preparation', async () => {
  const action = release.jobs.version.steps[0];
  assert.equal(action.with['skip-github-release'] ?? false, false);
  const config = JSON.parse(await read(action.with['config-file']));
  assert.equal(config.packages['.'].draft, true);
  assert.equal(config.packages['.']['force-tag-creation'], true);
  assert.equal(release.jobs.version.outputs.tag, '${{ steps.release.outputs.tag_name }}');
  assert.equal(release.jobs.version.outputs.sha, '${{ steps.release.outputs.sha }}');
  assert.equal(release.jobs.release.needs, 'version');
  assert.equal(release.jobs.release.if, "needs.version.outputs.release_created == 'true'");
  assert.equal(
    evaluate(release.jobs.release.if, {
      needs: { version: { outputs: { release_created: 'true', prs_created: 'false' } } },
    }),
    true,
  );
});

test('the actual release handoff uses the merged release SHA and tag even after main advances', () => {
  const step = release.jobs.release.steps[0];
  assert.equal(step.env.RELEASE_TAG, '${{ needs.version.outputs.tag }}');
  assert.equal(step.env.RELEASE_SHA, '${{ needs.version.outputs.sha }}');
  const env = {
    GH_REPO: 'example/project',
    RELEASE_TAG: 'v2.3.0',
    RELEASE_SHA: 'a'.repeat(40),
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_REF: 'refs/heads/main',
  };
  const calls = [];
  runInline(step.run, env, (...args) => calls.push(args));
  assert.deepEqual(calls, [
    [
      'gh',
      [
        'workflow',
        'run',
        'publish-release.yml',
        '--repo',
        'example/project',
        '--ref',
        'v2.3.0',
        '-f',
        'tag=v2.3.0',
        '-f',
        `sha=${env.RELEASE_SHA}`,
      ],
      { stdio: 'inherit' },
    ],
  ]);
  for (const change of [{ RELEASE_TAG: 'main' }, { RELEASE_SHA: 'short' }]) {
    assert.throws(() => runInline(step.run, { ...env, ...change }));
  }
});

test('publication retains exact-source verification and the separate owner environment gate', () => {
  assert.deepEqual(Object.keys(publisher.on), ['workflow_dispatch']);
  assert.equal(publisher.jobs.verify.with.ref, '${{ inputs.sha }}');
  assert.equal(publisher.jobs.verify.with.release_tag, '${{ inputs.tag }}');
  assert.equal(publisher.jobs.notes.with.sha, '${{ inputs.sha }}');
  assert.equal(publisher.jobs.publish.environment.name, 'release');
  assert.deepEqual(publisher.jobs.publish.needs, ['preflight', 'candidate', 'provenance']);
  const needs = Object.fromEntries(
    publisher.jobs.publish.needs.map((name) => [name, { result: 'success' }]),
  );
  const values = { github: { run_attempt: 1 }, needs, always: () => true };
  assert.equal(evaluate(publisher.jobs.publish.if, values), true);
  for (const dependency of Object.values(needs)) {
    dependency.result = 'skipped';
    assert.equal(evaluate(publisher.jobs.publish.if, values), false);
    dependency.result = 'success';
  }
});

test('the actual publication guard requires exactly one approved decision from the configured owner', () => {
  const shell = publisher.jobs.publish.steps.find((step) =>
    step.run?.includes('function requireOwnerApproval()'),
  )?.run;
  const source = shell?.match(
    /function requireOwnerApproval\(\) \{[\s\S]*?\n\}\nrequireOwnerApproval\(\);/,
  )?.[0];
  assert.ok(source, 'Expected the publication guard and its immediate invocation');
  const execute = new Function('assert', 'e', 'api', 'execFileSync', source);
  const owner = publisher.env.RELEASE_APPROVER_ID;
  const e = {
    GH_REPO: 'example/project',
    GITHUB_RUN_ID: '123',
    ENVIRONMENT_ID: '8',
    APPROVER_ID: owner,
    RELEASE_APPROVER_ID: owner,
  };
  const environment = {
    id: 8,
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [
      {
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: [{ type: 'User', reviewer: { id: Number(owner), type: 'User' } }],
      },
    ],
  };
  const approval = {
    state: 'approved',
    user: { id: Number(owner), type: 'User' },
    environments: [{ id: 8 }],
  };
  const run = (reviews) =>
    execute(
      assert,
      e,
      (path) => {
        if (path === 'environments/release') return environment;
        assert.equal(path, 'actions/runs/123/approvals');
        return reviews;
      },
      (command, args) => {
        assert.equal(command, 'gh');
        assert.deepEqual(args, [
          'api',
          '--method',
          'GET',
          '--paginate',
          '--slurp',
          'repos/example/project/environments/release/deployment-branch-policies?per_page=100',
        ]);
        return JSON.stringify([{ branch_policies: [{ name: 'v*', type: 'tag' }] }]);
      },
    );
  assert.doesNotThrow(() => run([approval]));
  for (const reviews of [
    [],
    [approval, approval],
    [{ ...approval, user: { id: 999, type: 'User' } }],
    [{ ...approval, state: 'rejected' }],
    [{ ...approval, environments: [{ id: 9 }] }],
  ])
    assert.throws(() => run(reviews), assert.AssertionError);
});

test('native required PR checks stay unfiltered and metadata-only title validation cannot be skipped', () => {
  assert.equal(ci.on.pull_request, null);
  assert.deepEqual(title.on.pull_request_target.types, [
    'opened',
    'edited',
    'reopened',
    'synchronize',
  ]);
  assert.deepEqual(title.permissions, { 'pull-requests': 'read' });
  assert.equal(title.jobs.title.name, 'Conventional Commit PR title');
  assert.equal(
    evaluate(title.jobs.title.steps[0].if, { github: { event_name: 'pull_request_target' } }),
    true,
  );
  for (const property of ['if', 'needs', 'strategy', 'uses'])
    assert.equal(title.jobs.title[property], undefined);
  assert.doesNotMatch(JSON.stringify(title), /checkout@/);
  const aggregate = ci.jobs['all-checks'];
  assert.equal(aggregate.name, 'All checks');
  assert.equal(aggregate.if, 'always()');
  assert.deepEqual(
    aggregate.needs.toSorted(),
    Object.keys(ci.jobs)
      .filter((name) => name !== 'all-checks')
      .sort(),
  );
  const results = Object.fromEntries(aggregate.needs.map((name) => [name, { result: 'success' }]));
  const run = () => runInline(aggregate.steps[0].run, { RESULTS: JSON.stringify(results) });
  assert.doesNotThrow(run);
  for (const result of ['skipped', 'cancelled', 'failure']) {
    results.mutation.result = result;
    assert.throws(run, /Required jobs did not pass: mutation/);
  }
  delete results.mutation;
  assert.throws(run, /Incomplete or unexpected job inventory/);
});
