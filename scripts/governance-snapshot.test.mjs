import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repository = 'repos/Lunary-Lab/mp3-frame-analyzer';
const script = resolve('governance/snapshot.sh');

function snapshot(responses = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'governance-snapshot-'));
  try {
    const fixtures = join(directory, 'responses.json');
    const calls = join(directory, 'calls.jsonl');
    writeFileSync(
      fixtures,
      JSON.stringify({ [repository]: { status: 200, body: {} }, ...responses }),
    );
    writeFileSync(calls, '');
    // Only this local stub can resolve as gh. It never opens a network connection.
    writeFileSync(
      join(directory, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SNAPSHOT_CALLS, JSON.stringify(args) + '\\n');
const endpoint = args.find((arg) => /^(repos|orgs)\\//.test(arg));
const fixtures = JSON.parse(fs.readFileSync(process.env.SNAPSHOT_FIXTURES, 'utf8'));
const response = fixtures[endpoint] || {status: 403, body: {message: 'Unavailable fixture'}};
if (args.includes('--silent')) process.exit(response.status >= 400 ? 1 : 0);
if (args.includes('--paginate')) {
  if (response.paginationFailure) process.exit(1);
  process.stdout.write(JSON.stringify(response.pages ?? [response.body]));
} else {
  process.stdout.write('HTTP/2.0 ' + response.status + ' Fixture\\n\\n' + JSON.stringify(response.body));
}
process.exit(response.status >= 400 ? 1 : 0);
`,
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        SNAPSHOT_FIXTURES: fixtures,
        SNAPSHOT_CALLS: calls,
      },
    });
    assert.ifError(result.error);
    return {
      ...result,
      calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function settings(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).settings;
}

test('snapshot never requests secret-scanning alert payloads', () => {
  const result = snapshot();
  settings(result);
  assert.ok(
    result.calls.every((args) => args.every((arg) => !arg.includes('secret-scanning/alerts'))),
  );
});

test('snapshot combines every array page and preserves unavailable status', () => {
  const endpoint = `${repository}/keys`;
  const first = { title: 'zeta', read_only: true, key: 'omit' };
  const second = { title: 'alpha', read_only: false, key: 'omit' };
  const result = snapshot({
    [endpoint]: { status: 200, body: [first], pages: [[first], [second]] },
  });
  const values = settings(result);
  assert.deepEqual(values.deploy_keys.value, [
    { title: 'alpha', read_only: false },
    { title: 'zeta', read_only: true },
  ]);
  assert.deepEqual(values.rulesets, { status: 403, unavailable: 'Unavailable fixture' });
  assert.ok(result.calls.some((args) => args.includes(endpoint) && args.includes('--paginate')));
  assert.ok(result.calls.some((args) => args.includes(endpoint) && args.includes('--slurp')));
  assert.ok(!result.stdout.includes('omit'));
});

test('snapshot combines wrapped pages and omits variable values', () => {
  const endpoint = `${repository}/actions/variables`;
  const first = { name: 'ZETA', value: 'OMIT-THIS-SYNTHETIC-VALUE' };
  const second = { name: 'ALPHA', value: 'OMIT-THIS-SYNTHETIC-VALUE' };
  const result = snapshot({
    [endpoint]: {
      status: 200,
      body: { variables: [first] },
      pages: [{ variables: [first] }, { variables: [second] }],
    },
  });
  assert.deepEqual(settings(result).actions_variable_names.value, ['ALPHA', 'ZETA']);
  assert.ok(!result.stdout.includes('OMIT-THIS-SYNTHETIC-VALUE'));
});

test('snapshot accepts complete empty arrays and wrapped collections', () => {
  const result = snapshot({
    [`${repository}/keys`]: { status: 200, body: [], pages: [[]] },
    [`${repository}/actions/secrets`]: {
      status: 200,
      body: { secrets: [] },
      pages: [{ secrets: [] }],
    },
  });
  const values = settings(result);
  assert.deepEqual(values.deploy_keys.value, []);
  assert.deepEqual(values.actions_secret_names.value, []);
});

test('public snapshot excludes organization and people inventories', () => {
  const result = snapshot();
  const values = settings(result);
  for (const key of [
    'organization',
    'organization_rulesets',
    'organization_secret_names',
    'organization_variable_names',
    'organization_owners',
    'collaborators',
    'teams',
  ]) {
    assert.ok(!Object.hasOwn(values, key), `Restored private inventory: ${key}`);
  }
  assert.ok(
    result.calls.every((args) =>
      args.every((arg) => !arg.startsWith('orgs/') && !/\/(collaborators|teams)([?/]|$)/.test(arg)),
    ),
  );
});

test('malformed pages and failed pagination never become a successful empty collection', () => {
  const endpoint = `${repository}/keys`;
  for (const pages of [[], [null], [[], {}]]) {
    const result = snapshot({ [endpoint]: { status: 200, body: [], pages } });
    assert.notEqual(result.status, 0, `Accepted invalid pages: ${JSON.stringify(pages)}`);
  }
  const wrapped = snapshot({
    [`${repository}/actions/variables`]: {
      status: 200,
      body: { variables: [] },
      pages: [{ variables: [] }, {}],
    },
  });
  assert.notEqual(wrapped.status, 0);
  const failed = snapshot({ [endpoint]: { status: 200, body: [], paginationFailure: true } });
  assert.notEqual(failed.status, 0);
});

test('an unreadable repository fails before collecting any other settings', () => {
  const result = snapshot({ [repository]: { status: 404, body: { message: 'Not Found' } } });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 1);
});

test('every public collection is paginated, including native release-policy inventories', () => {
  const collections = [
    ['rulesets', 'rulesets', '.', { id: 2 }, { id: 1 }],
    ['environments', 'environments', 'environments', { name: 'zeta' }, { name: 'alpha' }],
    [
      'environments/release/deployment-branch-policies',
      'release_deployment_policies',
      'branch_policies',
      { name: 'v2*', type: 'tag', ignored: 'OMIT' },
      { name: 'v1*', type: 'tag', ignored: 'OMIT' },
    ],
    [
      'rulesets?includes_parents=false',
      'rulesets_detail',
      '.',
      { name: 'zeta', target: 'tag', enforcement: 'active', ignored: 'OMIT' },
      { name: 'alpha', target: 'branch', enforcement: 'active', ignored: 'OMIT' },
    ],
    ['actions/secrets', 'actions_secret_names', 'secrets', { name: 'ZETA' }, { name: 'ALPHA' }],
    [
      'dependabot/secrets',
      'dependabot_secret_names',
      'secrets',
      { name: 'ZETA' },
      { name: 'ALPHA' },
    ],
    ['hooks', 'webhooks', '.', { name: 'zeta' }, { name: 'alpha' }],
    ['autolinks', 'autolinks', '.', { id: 2 }, { id: 1 }],
    ['releases?per_page=100', 'releases', '.', { tag_name: 'v2' }, { tag_name: 'v1' }],
    ['git/matching-refs/tags/', 'tags', '.', { ref: 'refs/tags/v2' }, { ref: 'refs/tags/v1' }],
  ];
  const responses = Object.fromEntries(
    collections.map(([suffix, , key, first, second]) => {
      const page = (value) => (key === '.' ? [value] : { [key]: [value] });
      return [
        `${repository}/${suffix}`,
        { status: 200, body: page(first), pages: [page(first), page(second)] },
      ];
    }),
  );
  const result = snapshot(responses);
  const values = settings(result);
  for (const [suffix, label] of collections) {
    assert.ok(
      result.calls.some(
        (args) =>
          args.includes(`${repository}/${suffix}`) &&
          args.includes('--paginate') &&
          args.includes('--slurp'),
      ),
      `Not paginated: ${label}`,
    );
    assert.equal(label === 'autolinks' ? values[label].value : values[label].value.length, 2);
  }
  assert.deepEqual(values.release_deployment_policies.value, [
    { name: 'v1*', type: 'tag' },
    { name: 'v2*', type: 'tag' },
  ]);
  assert.deepEqual(values.rulesets_detail.value, [
    { name: 'alpha', target: 'branch', enforcement: 'active' },
    { name: 'zeta', target: 'tag', enforcement: 'active' },
  ]);
  assert.ok(!result.stdout.includes('OMIT'));
});

test('native release approval settings retain their existing sanitized projection', () => {
  const policy = { protected_branches: false, custom_branch_policies: true };
  const result = snapshot({
    [`${repository}/environments/release`]: {
      status: 200,
      body: {
        name: 'release',
        can_admins_bypass: false,
        deployment_branch_policy: policy,
        protection_rules: [
          {
            type: 'required_reviewers',
            prevent_self_review: false,
            reviewers: [
              { type: 'User', reviewer: { login: 'synthetic-owner', id: 123, email: 'OMIT' } },
            ],
          },
        ],
      },
    },
  });
  assert.deepEqual(settings(result).environments_release.value, {
    name: 'release',
    can_admins_bypass: false,
    deployment_branch_policy: policy,
    protection_rules: [
      {
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: [{ type: 'User', login: 'synthetic-owner' }],
      },
    ],
  });
  assert.ok(!result.stdout.includes('OMIT'));
});
