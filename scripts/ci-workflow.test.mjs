import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = await readFile(
  new URL('../.github/workflows/release-please.yml', import.meta.url),
  'utf8',
);
const mutationAction = await readFile(
  new URL('../.github/actions/test-mutations/action.yml', import.meta.url),
  'utf8',
);
const required = [
  'format',
  'lint',
  'types',
  'unit',
  'compatibility',
  'tooling',
  'mutation-cache',
  'mutation',
  'encoder',
  'npm-audit',
  'trivy',
  'trivy-release',
  'secrets',
  'semgrep',
  'fuzz',
  'package',
  'governance',
];

function job(name) {
  const found = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:|$(?![\\s\\S]))`,
    'm',
  ).exec(ci.slice(ci.indexOf('jobs:\n')));
  assert.ok(found, `Missing ${name} job`);
  return found[1];
}

function context({ event = 'push', ref = 'refs/heads/main', head = '', run = 1, ...inputs } = {}) {
  return {
    inputs: { ref: '', release_tag: '', full_mutation: false, ...inputs },
    github: {
      event_name: event,
      ref,
      head_ref: head,
      run_id: run,
      workflow: 'CI',
      repository: 'example/project',
      event: { pull_request: { number: 7, head: { repo: { full_name: 'example/project' } } } },
    },
  };
}

// These workflow expressions use only typed boolean/string operations and format().
// Evaluate the actual YAML expressions with that subset; actionlint checks native syntax.
function evaluate(expression, values) {
  return runInNewContext(
    expression,
    {
      ...values,
      format: (pattern, ...args) => pattern.replace(/\{(\d+)\}/g, (_, i) => String(args[i])),
    },
    { timeout: 100 },
  );
}

function concurrency(values) {
  const group = ci.match(/^ {2}group: (.+)$/m)?.[1];
  const cancel = ci.match(/^ {2}cancel-in-progress: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(group && cancel, 'Concurrency must be explicit native expressions');
  return {
    group: group
      .replace(/\$\{\{ (.+) \}\}/g, (_, expression) => evaluate(expression, values))
      .toLowerCase(),
    cancel: evaluate(cancel, values),
  };
}

test('ordinary main, PR and explicit non-full manual runs supersede the same branch only', () => {
  for (const [event, ref, head, expected] of [
    ['push', 'refs/heads/main', '', 'refs/heads/main'],
    ['workflow_dispatch', 'refs/heads/main', '', 'refs/heads/main'],
    ['pull_request', 'refs/pull/7/merge', 'feature', 'refs/heads/feature'],
    ['workflow_dispatch', 'refs/heads/feature', '', 'refs/heads/feature'],
    [
      'pull_request',
      'refs/pull/8/merge',
      'release-please--branches--main',
      'refs/heads/release-please--branches--main',
    ],
    [
      'workflow_dispatch',
      'refs/heads/release-please--branches--main',
      '',
      'refs/heads/release-please--branches--main',
    ],
  ]) {
    assert.deepEqual(concurrency(context({ event, ref, head })), {
      group: `ci-validation-${expected}`,
      cancel: true,
    });
  }
});

test('scheduled and explicitly full manual runs cannot replace one another while pending', () => {
  const ordinary = concurrency(context());
  for (const values of [
    { event: 'schedule' },
    { event: 'workflow_dispatch', full_mutation: true },
  ]) {
    const first = concurrency(context({ ...values, run: 101 }));
    const second = concurrency(context({ ...values, run: 102 }));
    assert.equal(first.cancel, false);
    assert.equal(second.cancel, false);
    assert.notEqual(first.group, second.group);
    assert.notEqual(first.group, ordinary.group);
  }
});

test('fork branch names cannot cancel trusted main or other forks', () => {
  const first = context({ event: 'pull_request', head: 'main', ref: 'refs/pull/7/merge' });
  first.github.event.pull_request.head.repo.full_name = 'other/fork';
  const second = structuredClone(first);
  second.github.event.pull_request.number = 8;
  assert.equal(concurrency(first).cancel, true);
  assert.notEqual(concurrency(first).group, concurrency(context()).group);
  assert.notEqual(concurrency(first).group, concurrency(second).group);
});

test('exact-source release validation is isolated and never cancels in progress', () => {
  const values = context({ event: 'workflow_dispatch', release_tag: 'v2.1.0' });
  values.inputs.ref = 'a'.repeat(40);
  const result = concurrency(values);
  assert.deepEqual(result, { group: `ci-release-v2.1.0-${'a'.repeat(40)}`, cancel: false });
  assert.notEqual(result.group, concurrency(context()).group);
  values.inputs.release_tag = 'v2.1.1';
  assert.notEqual(result.group, concurrency(values).group);
});

test('the stable aggregate needs exactly every native validation job', () => {
  const jobs = [...ci.slice(ci.indexOf('jobs:\n')).matchAll(/^ {2}([a-z][a-z0-9-]+):$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'all-checks');
  assert.deepEqual(jobs.sort(), [...required].sort());
  const aggregate = job('all-checks');
  const needs = aggregate
    .match(/needs:\s*\[([^\]]+)\]/)?.[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  assert.deepEqual(needs?.sort(), [...required].sort());
  assert.match(aggregate, /name: All checks\n/);
  assert.match(aggregate, /if: always\(\)/);
  assert.doesNotMatch(ci, /queue:|continue-on-error:/);
});

test('the actual aggregate program rejects every failure, cancellation, missing or skipped job', () => {
  const program = job('all-checks').split("<<'JS'\n")[1]?.split('\n          JS')[0];
  assert.ok(program);
  const run = (results) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      env: { RESULTS: JSON.stringify(results) },
      encoding: 'utf8',
      timeout: 5000,
    }).status;
  const success = () => Object.fromEntries(required.map((name) => [name, { result: 'success' }]));
  assert.equal(run(success()), 0);
  for (const name of required) {
    for (const result of ['failure', 'cancelled', 'skipped', 'unknown']) {
      assert.notEqual(run({ ...success(), [name]: { result } }), 0);
    }
    const missing = success();
    delete missing[name];
    assert.notEqual(run(missing), 0);
  }
  for (const malformed of [null, [], {}, { ...success(), extra: { result: 'success' } }]) {
    assert.notEqual(run(malformed), 0);
  }
});

test('the complete cache campaign is required and parallel to parser mutation', () => {
  assert.match(job('mutation-cache'), /npm run test:mutation-cache:integration/);
  assert.doesNotMatch(job('mutation-cache'), /needs:|--impact-only/);
  assert.match(job('mutation'), /needs: \[types, unit, tooling\]/);
  assert.match(mutationAction, /verify-encoder-discovery\.mjs reports\/mutation\/mutation\.json/);
  assert.match(job('mutation'), /inputs\.full_mutation == true/);
  assert.match(mutationAction, /node scripts\/run-mutations\.mjs --full/);
  assert.match(job('mutation'), /uses: \.\/\.github\/actions\/test-mutations/);
});

test('only ordinary validation can restore results; every protected validation forces full', () => {
  const mutation = job('mutation');
  const full = mutation.match(/full: \$\{\{ (.+) \}\}/)?.[1];
  const restore = `!(${full})`;
  assert.ok(restore && full);
  for (const values of [
    context(),
    context({ event: 'pull_request', head: 'feature' }),
    context({ event: 'workflow_dispatch', full_mutation: false }),
  ]) {
    assert.equal(evaluate(restore, values), true);
    assert.equal(evaluate(full, values), false);
  }
  for (const values of [
    context({ event: 'schedule' }),
    context({ event: 'workflow_dispatch', full_mutation: true }),
    context({ event: 'workflow_dispatch', ref: 'refs/tags/v2.1.0', release_tag: 'v2.1.0' }),
  ]) {
    assert.equal(evaluate(restore, values), false);
    assert.equal(evaluate(full, values), true);
  }
  const exactSource = context({ event: 'workflow_dispatch' });
  exactSource.inputs.ref = 'a'.repeat(40);
  assert.equal(evaluate(restore, exactSource), false);
  assert.equal(evaluate(full, exactSource), true);
});

test('existing scans, production-only archive smoke and release dispatch remain required', () => {
  assert.match(job('npm-audit'), /scope: \[production, full\]/);
  assert.match(job('npm-audit'), /npm run audit:production/);
  assert.match(job('npm-audit'), /npm run audit:dependencies/);
  assert.match(job('secrets'), /fetch-depth: 0/);
  assert.match(job('secrets'), /betterleaks.*git \. --no-banner/);
  assert.match(job('semgrep'), /semgrep.*scan --config \.semgrep\.yml.*--error/);
  assert.match(job('package'), /npm run test:artifact/);
  assert.match(job('package'), /name: release-assets/);
  assert.match(job('package'), /SOURCE_COMMIT: \$\{\{ inputs\.ref \|\| github\.sha \}\}/);
  assert.match(release, /'ci\.yml'[^\n]+ '-f', 'full_mutation=false'/);
});

test('reusable release outputs bind the verified upload and its exact workflow attempt', () => {
  for (const name of ['release_artifact_id', 'release_artifact_digest', 'release_run_attempt'])
    assert.ok(ci.includes(`value: \${{ jobs.package.outputs.${name} }}`));
  const packaging = job('package');
  assert.match(
    packaging,
    /release_artifact_id: \$\{\{ steps\.release-assets\.outputs\.artifact-id \}\}/,
  );
  assert.match(
    packaging,
    /release_artifact_digest: \$\{\{ steps\.release-assets\.outputs\.artifact-digest \}\}/,
  );
  assert.match(packaging, /release_run_attempt: \$\{\{ github\.run_attempt \}\}/);
  assert.match(packaging, /id: release-assets\n/);
  assert.match(packaging, /name: release-assets-\$\{\{ github\.run_attempt \}\}/);
  assert.ok(packaging.indexOf('npm run test:artifact') < packaging.indexOf('id: release-assets'));
  assert.doesNotMatch(
    packaging.slice(packaging.indexOf('id: release-assets')),
    /npm run (build|package:release)/,
  );
});

test('native scanner and setup commands retain pinned versions and explicit reporting controls', async () => {
  const setup = await readFile(
    new URL('../.github/actions/setup-project/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(setup, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(setup, /node scripts\/bootstrap-npm\.mjs "\$NPM_VERSION"/);
  assert.doesNotMatch(setup, /npm install --global/);
  for (const setting of [
    "NPM_CONFIG_UPDATE_NOTIFIER: 'false'",
    "PIP_DISABLE_PIP_VERSION_CHECK: '1'",
    "SEMGREP_SEND_METRICS: 'off'",
    "SEMGREP_ENABLE_VERSION_CHECK: '0'",
    "OTEL_SDK_DISABLED: 'true'",
  ])
    assert.ok(ci.includes(setting), setting);
  for (const name of ['lint', 'secrets']) {
    assert.match(job(name), /go telemetry off/);
    assert.match(job(name), /test "\$\(go env GOTELEMETRY\)" = off/);
  }
  const scannerLock = await readFile(
    new URL('../.github/security/semgrep-requirements.txt', import.meta.url),
    'utf8',
  );
  assert.match(scannerLock, /^semgrep==1\.182\.1 --hash=sha256:[a-f0-9]{64}$/m);
  const scanner = job('semgrep');
  assert.match(scanner, /Semgrep lock requires CPython 3\.12 on Linux x86_64/);
  assert.match(scanner, /export PIP_CONFIG_FILE=\/dev\/null/);
  assert.match(
    scanner,
    /-I -m pip --isolated --disable-pip-version-check download --index-url https:\/\/pypi\.org\/simple/,
  );
  assert.match(
    scanner,
    /download .* --require-hashes --only-binary=:all: --no-cache-dir --dest "\$wheels"/,
  );
  assert.match(
    scanner,
    /-I -m pip --isolated --disable-pip-version-check install --no-index --find-links "\$wheels"/,
  );
  assert.match(
    scanner,
    /install .* --require-hashes --only-binary=:all: --no-cache-dir --requirement "\$lock"/,
  );
  assert.match(scanner, /-I -m pip --isolated --disable-pip-version-check --no-cache-dir check/);
  assert.match(scanner, /-I scripts\/test-semgrep-lock\.py "\$wheels"/);
  assert.match(job('semgrep'), /--strict --error --metrics=off --disable-version-check --no-trace/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['audit:production'], 'npm audit --omit=dev --audit-level=moderate');
  assert.equal(pkg.scripts['audit:dependencies'], 'npm audit --audit-level=moderate');
});

test('modularization retains the existing external action pins and read-only token scopes', async () => {
  const setup = await readFile(
    new URL('../.github/actions/setup-project/action.yml', import.meta.url),
    'utf8',
  );
  const actions = [...`${ci}\n${setup}`.matchAll(/uses: ([^\s]+)/g)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith('./'));
  assert.deepEqual([...new Set(actions)].sort(), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
    'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
    'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
    'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  ]);
  assert.match(ci, /^permissions:\n {2}contents: read\n/m);
  assert.match(job('mutation'), /permissions:\n {6}contents: read\n {6}actions: read\n/);
  assert.equal([...ci.matchAll(/permissions:/g)].length, 2);
  assert.doesNotMatch(ci, /secrets\.|: write\b|persist-credentials: true/);
});

test('required lint runs repository-wide native pin enforcement without a skipped lane', () => {
  const lint = job('lint');
  assert.match(lint, /uses: \.\/\.github\/actions\/setup-zizmor/);
  assert.match(
    lint,
    /node scripts\/verify-workflow-pins\.mjs "\$\{RUNNER_TEMP\}\/zizmor-tool\/zizmor"/,
  );
  assert.doesNotMatch(lint, /if:|continue-on-error:|--no-exit-codes|--format=sarif/);
});

test('governance is mandatory and checks the same explicit source ref as the CI caller', async () => {
  const governance = await readFile(
    new URL('../.github/workflows/governance.yml', import.meta.url),
    'utf8',
  );
  assert.match(job('governance'), /uses: \.\/\.github\/workflows\/governance\.yml/);
  assert.match(job('governance'), /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/);
  assert.doesNotMatch(job('governance'), /if:|secrets:|: write\b/);
  assert.match(governance, /workflow_call:\n\s+inputs:\n\s+ref:\n/);
  assert.match(governance, /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/);
  assert.match(governance, /persist-credentials: false/);
  assert.match(governance, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(governance, /pull_request:|push:|paths:|: write\b|secrets\./);
  assert.match(governance, /terraform fmt -check -recursive -diff/);
  assert.match(governance, /terraform init -backend=false -input=false -lockfile=readonly/);
  assert.match(governance, /terraform validate/);
  assert.match(governance, /run: terraform test/);
  assert.doesNotMatch(governance, /terraform (apply|destroy)|GITHUB_TOKEN:/);
});

test('Trivy full and exact tested-release scans remain required without source uploads', async () => {
  assert.match(job('trivy'), /trivy-gate\.mjs.* full/);
  assert.match(job('trivy-release'), /needs: package/);
  assert.match(
    job('trivy-release'),
    /artifact-ids: \$\{\{ needs\.package\.outputs\.release_artifact_id \}\}/,
  );
  assert.match(job('trivy-release'), /digest-mismatch: error/);
  assert.doesNotMatch(job('trivy-release'), /name: release-assets|github-token:|run-id:/);
  assert.match(job('trivy-release'), /trivy-gate\.mjs.* release/);
  for (const name of ['trivy', 'trivy-release']) {
    assert.match(job(name), /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/);
    assert.doesNotMatch(job(name), /continue-on-error|secrets\.|: write|upload-artifact|npm ci/);
  }
  const bootstrap = await readFile(
    new URL('../.github/actions/setup-trivy/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(bootstrap, /trivy_0\.76\.1_Linux-64bit\.tar\.gz/);
  assert.match(bootstrap, /c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0/);
  assert.ok(bootstrap.indexOf('sha256sum --check --strict') < bootstrap.indexOf('tar -xzf'));
});

test('Trivy refuses empty, multiple or malformed producer IDs before artifact download', () => {
  const consumer = job('trivy-release');
  const guard = consumer.indexOf('Require the exact producer artifact identity before download');
  assert.ok(guard > 0 && guard < consumer.indexOf('uses: actions/download-artifact@'));
  const script = consumer.match(/node --input-type=module <<'NODE'\n([\s\S]+?)\n {10}NODE/)?.[1];
  assert.ok(script);
  const run = (changes = {}) =>
    spawnSync(process.execPath, ['--input-type=module'], {
      input: script,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARTIFACT_ID: '123',
        ARTIFACT_DIGEST: 'a'.repeat(64),
        ARTIFACT_ATTEMPT: '1',
        GITHUB_RUN_ATTEMPT: '2',
        ...changes,
      },
    }).status;
  assert.equal(run(), 0);
  for (const id of ['', '0', '01', '1,2', '*', '123\n', '9007199254740992'])
    assert.notEqual(run({ ARTIFACT_ID: id }), 0, `Accepted artifact ID ${JSON.stringify(id)}`);
  for (const changes of [
    { ARTIFACT_DIGEST: '' },
    { ARTIFACT_DIGEST: 'a'.repeat(63) },
    { ARTIFACT_ATTEMPT: '' },
    { ARTIFACT_ATTEMPT: '0' },
    { ARTIFACT_ATTEMPT: '3' },
  ])
    assert.notEqual(run(changes), 0);
});

test('the parent mutation execution contract is fixed while unrelated CI jobs may change', async () => {
  const contract = JSON.parse(
    await readFile(new URL('./mutation-job-contract.json', import.meta.url), 'utf8'),
  );
  // This small explicit snapshot is an input to the cache key. Changing checkout,
  // setup, runner, permissions, force/publish expressions or command ordering must
  // update it and therefore invalidate results; no semantic YAML cache interpreter.
  assert.deepEqual(parse(ci).jobs.mutation, contract);
  const steps = parse(mutationAction).runs.steps;
  const download = steps.find((step) => step.id === 'download');
  assert.equal(download.with['digest-mismatch'], 'error');
  assert.equal(download['continue-on-error'], true);
  assert.match(
    steps.find((step) => step.run?.includes('run-mutations')).env.MUTATION_BASELINE_SHA,
    /steps.download.outcome == 'success'/,
  );
  assert.equal(
    steps.find((step) => step.with?.archive === false).with.path,
    '.cache/mutation/native-baseline.json',
  );
});
