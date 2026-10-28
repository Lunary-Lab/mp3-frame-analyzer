import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  BASELINE,
  PR_BASELINE,
  WORKING_REPORT,
  executionSummary,
  fingerprint,
  promoteCache,
  pullRequestIdentity,
  readCache,
} from './mutation-cache.mjs';
import { sourceContext } from './mutation-policy.mjs';

const commit = 'a'.repeat(40);
const inputs = { files: [['src/mp3/example.ts', 420, 'source-hash']] };
const key = fingerprint(inputs);
const prEnv = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REF: 'refs/pull/7/merge',
  GITHUB_REPOSITORY_ID: '42',
  GITHUB_SHA: 'c'.repeat(40),
  MUTATION_BASELINE_SHA: commit,
};
const report = {
  valid: true,
  files: { 'src/mp3/example.ts': { mutants: [{ status: 'Killed', duration: 0 }] } },
  testFiles: {},
};
const prReport = { ...report, cacheSource: 'own-pr' };
const mainReport = { ...report, cacheSource: 'authenticated-main' };
const summary = {
  rawScore: 100,
  adjustedScore: 100,
  adjustedDetected: 1,
  adjustedTotal: 1,
  killed: 1,
  timedOut: 0,
  equivalent: 0,
  timedOutEquivalents: [],
};
const runnerSource = await readFile(new URL('./run-mutations.mjs', import.meta.url), 'utf8');
// Execute the complete runner body with fake process/discovery boundaries. The
// actual source-proof check, cache admission, filesystem cleanup and finally run.
const runnerBody = runnerSource
  .slice(runnerSource.indexOf('const root ='))
  .replaceAll('import.meta.url', 'runnerUrl')
  .replaceAll('import.meta.resolve(', 'resolve(');

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mutation-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = 'export const value = 1;\n';
  await mkdir(join(root, 'src/mp3'), { recursive: true });
  await writeFile(join(root, 'src/mp3/example.ts'), source);
  await writeFile(
    join(root, 'mutation-equivalents.json'),
    JSON.stringify({
      contextSha256: options.staleProof
        ? 'stale'
        : sourceContext(new Map([['src/mp3/example.ts', source]])),
    }),
  );
  const outputPath = join(root, 'github-output');
  await writeFile(outputPath, '');
  const env = { ...prEnv, GITHUB_OUTPUT: outputPath, ...options.env };
  const identity = env.MUTATION_PR_CACHE_RESTORED === 'true' ? pullRequestIdentity(env) : commit;
  for (const [cache, cacheIdentity, cachedReport] of [
    [options.cache, identity, options.cacheReport ?? report],
    [options.mainCache, options.mainIdentity ?? commit, mainReport],
  ]) {
    if (!cache) continue;
    const baselinePath = join(root, cacheIdentity?.startsWith('pr:') ? PR_BASELINE : BASELINE);
    await promoteCache(root, cachedReport, key, cacheIdentity);
    const envelope = JSON.parse(await readFile(baselinePath, 'utf8'));
    if (cache === 'incompatible') envelope.key = 'f'.repeat(64);
    if (cache === 'unauditable') envelope.report = { valid: false };
    await writeFile(baselinePath, cache === 'corrupt' ? '{partial' : JSON.stringify(envelope));
  }
  const calls = {
    discovery: 0,
    processes: [],
    promotions: [],
    reads: [],
    audits: [],
    workingReports: [],
    ended: 0,
  };
  const messages = [];
  const processState = {
    argv: ['node', 'run-mutations.mjs', ...(options.args ?? ['--parallel-fallback'])],
    env,
  };
  const context = {
    URL,
    runnerUrl: pathToFileURL(join(root, 'scripts/run-mutations.mjs')).href,
    resolve: (specifier) => pathToFileURL(join(root, 'node_modules', specifier)).href,
    fileURLToPath,
    dirname,
    join,
    relative,
    readFile,
    readdir,
    rm,
    mkdir,
    writeFile: async (path, ...args) => {
      if (options.diagnosticFailure && path.endsWith('routing.json'))
        throw new Error('diagnostic unavailable');
      await writeFile(path, ...args);
    },
    appendFile: async (path, bytes) => {
      const routing = JSON.parse(
        await readFile(join(root, 'reports/mutation/routing.json'), 'utf8'),
      );
      assert.equal(bytes, `route=${routing.route}\n`);
      if (options.outputFailure) throw new Error('output unavailable');
      await appendFile(path, bytes);
    },
    createWriteStream: () => ({ end: () => calls.ended++ }),
    process: processState,
    performance,
    console: Object.fromEntries(
      ['log', 'warn', 'error'].map((method) => [method, (message) => messages.push(message)]),
    ),
    BASELINE,
    PR_BASELINE,
    WORKING_REPORT,
    mutationEnvironment: () => (options.nodeOptions ? { NODE_OPTIONS: '--inspect=0' } : {}),
    mutationInputs: async () => {
      if (options.inputFailure) throw new Error('input unavailable');
      return inputs;
    },
    fingerprint,
    sourceContext,
    pullRequestIdentity,
    readCache: async (...values) => {
      calls.reads.push(values[2]);
      return readCache(...values);
    },
    executionSummary,
    auditMutations: (value, _policy, _sources, auditOptions) => {
      calls.audits.push({ value, options: auditOptions });
      if (!value?.valid || options.auditFailure) throw new Error('audit rejected report');
      return summary;
    },
    verifyParserTestDiscovery: async () => {
      calls.discovery++;
      return { selected: ['tests/mp3/example.test.ts'] };
    },
    runMutationProcess: async (command, args) => {
      calls.processes.push({ command, args: Array.from(args) });
      if (options.processFailure) throw new Error('native execution failed');
      if (command.endsWith('stryker.js')) {
        if (!args.includes('--force'))
          calls.workingReports.push(JSON.parse(await readFile(join(root, WORKING_REPORT), 'utf8')));
        if (options.strykerFailure) throw new Error('native Stryker execution failed');
        await writeFile(
          join(root, 'reports/mutation/mutation.json'),
          JSON.stringify(options.executionReport ?? report),
        );
      }
    },
    promoteCache: async (...values) => {
      calls.promotions.push(values[3]);
      await promoteCache(...values);
    },
  };
  await runInNewContext(`(async () => {${runnerBody}})()`, context, { timeout: 1000 });
  await assert.rejects(readFile(join(root, '.cache/mutation/run.lock')), { code: 'ENOENT' });
  return {
    root,
    calls,
    messages,
    exitCode: processState.exitCode ?? 0,
    route: await readFile(outputPath, 'utf8'),
  };
}

for (const [cache, reason] of [
  [undefined, 'missing'],
  ['incompatible', 'incompatible'],
  ['corrupt', 'corrupt-or-unauditable'],
  ['unauditable', 'corrupt-or-unauditable'],
])
  test(`cold hosted PR routes before discovery for a ${cache ?? 'missing'} baseline`, async (t) => {
    const result = await fixture(t, { cache });
    assert.equal(result.exitCode, 0);
    assert.equal(result.route, 'route=full-sharded\n');
    assert.equal(result.calls.discovery, 0);
    assert.deepEqual(result.calls.processes, []);
    assert.deepEqual(result.calls.promotions, []);
    assert.equal(result.calls.ended, 1);
    assert.ok(result.messages.some((message) => message.includes(`native-baseline-${reason}.`)));
    assert.deepEqual(
      JSON.parse(await readFile(join(result.root, 'reports/mutation/routing.json'), 'utf8')),
      {
        route: 'full-sharded',
        cacheReason: `native-baseline-${reason}`,
        inputsHash: key,
        inputCaptureError: null,
      },
    );
    await assert.rejects(readFile(join(result.root, 'reports/mutation/audit.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(readFile(join(result.root, BASELINE)), { code: 'ENOENT' });
    await assert.rejects(readFile(join(result.root, WORKING_REPORT)), { code: 'ENOENT' });
  });

for (const options of [
  { inputFailure: true },
  { nodeOptions: true, cache: 'valid' },
  { env: { GITHUB_HEAD_REPOSITORY_FORK: 'true' } },
])
  test(`PR routing remains eligible for ${JSON.stringify(options)}`, async (t) => {
    const result = await fixture(t, options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.route, 'route=full-sharded\n');
    assert.equal(result.calls.discovery, 0);
    assert.deepEqual(result.calls.processes, []);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.root, 'reports/mutation/routing.json'), 'utf8')),
      {
        route: 'full-sharded',
        cacheReason:
          options.inputFailure || options.nodeOptions
            ? 'native-full-required'
            : 'native-baseline-missing',
        inputsHash: options.inputFailure ? null : key,
        inputCaptureError: options.inputFailure ? 'unsupported-input' : null,
      },
    );
  });

for (const restored of ['false', 'true'])
  test(`warm PR keeps native reuse with own-PR restore=${restored}`, async (t) => {
    const result = await fixture(t, {
      cache: 'valid',
      env: { MUTATION_PR_CACHE_RESTORED: restored },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.route, 'route=native\n');
    assert.deepEqual(
      JSON.parse(await readFile(join(result.root, 'reports/mutation/routing.json'), 'utf8')),
      {
        route: 'native',
        cacheReason: 'native-same-input-reuse',
        inputsHash: key,
        inputCaptureError: null,
      },
    );
    assert.equal(result.calls.discovery, 1);
    assert.deepEqual(
      result.calls.processes.map(({ args }) => args),
      [['run', '--no-fsModuleCache'], ['run']],
    );
    assert.deepEqual(result.calls.promotions, ['pr:42:7']);
    assert.deepEqual(JSON.parse(await readFile(join(result.root, WORKING_REPORT), 'utf8')), report);
  });

for (const cache of [undefined, 'incompatible', 'corrupt', 'unauditable'])
  test(`rejected own-PR ${cache ?? 'missing'} cache falls back to authenticated main`, async (t) => {
    const result = await fixture(t, {
      cache,
      cacheReport: prReport,
      mainCache: 'valid',
      env: { MUTATION_PR_CACHE_RESTORED: 'true' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.route, 'route=native\n');
    assert.deepEqual(result.calls.reads, ['pr:42:7', commit]);
    assert.equal(result.calls.discovery, 1);
    assert.deepEqual(
      result.calls.processes.map(({ args }) => args),
      [['run', '--no-fsModuleCache'], ['run']],
    );
    assert.deepEqual(result.calls.workingReports, [mainReport]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.root, WORKING_REPORT), 'utf8')),
      mainReport,
    );
    const audit = JSON.parse(
      await readFile(join(result.root, 'reports/mutation/audit.json'), 'utf8'),
    );
    assert.equal(audit.execution.mode, 'incremental');
    assert.equal(audit.execution.cacheReason, 'native-same-input-reuse');
    assert.equal(audit.execution.baselineCommit, commit);
    assert.equal(audit.execution.baselinePR, null);
    assert.deepEqual(result.calls.promotions, ['pr:42:7']);
    const promoted = JSON.parse(await readFile(join(result.root, PR_BASELINE), 'utf8'));
    assert.deepEqual(promoted.report, report);
    assert.equal(promoted.prIdentity, 'pr:42:7');
    await assert.rejects(readFile(join(result.root, BASELINE)), { code: 'ENOENT' });
  });

test('admitted own-PR cache stays preferred without reading authenticated main', async (t) => {
  const result = await fixture(t, {
    cache: 'valid',
    cacheReport: prReport,
    mainCache: 'valid',
    env: { MUTATION_PR_CACHE_RESTORED: 'true' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.route, 'route=native\n');
  assert.deepEqual(result.calls.reads, ['pr:42:7']);
  assert.deepEqual(result.calls.workingReports, [prReport]);
  const audit = JSON.parse(
    await readFile(join(result.root, 'reports/mutation/audit.json'), 'utf8'),
  );
  assert.equal(audit.execution.baselineCommit, null);
  assert.equal(audit.execution.baselinePR, 'pr:42:7');
});

for (const mainCache of [undefined, 'incompatible', 'corrupt', 'unauditable'])
  test(`rejected own-PR and ${mainCache ?? 'missing'} main caches stay cold`, async (t) => {
    const result = await fixture(t, {
      cache: 'corrupt',
      mainCache,
      env: { MUTATION_PR_CACHE_RESTORED: 'true' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.route, 'route=full-sharded\n');
    assert.deepEqual(result.calls.reads, ['pr:42:7', commit]);
    assert.equal(result.calls.discovery, 0);
    assert.deepEqual(result.calls.processes, []);
    assert.deepEqual(result.calls.promotions, []);
    for (const path of [BASELINE, PR_BASELINE, WORKING_REPORT, 'reports/mutation/audit.json'])
      await assert.rejects(readFile(join(result.root, path)), { code: 'ENOENT' });
  });

for (const sha of [undefined, '', 'unknown', 'A'.repeat(40), 'local', 'pr:42:7'])
  test(`own-PR fallback never reads main without a trusted SHA: ${String(sha)}`, async (t) => {
    const result = await fixture(t, {
      cache: 'corrupt',
      mainCache: 'valid',
      mainIdentity: sha === 'local' ? 'local' : commit,
      env: { MUTATION_PR_CACHE_RESTORED: 'true', MUTATION_BASELINE_SHA: sha },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.route, 'route=full-sharded\n');
    assert.deepEqual(result.calls.reads, ['pr:42:7']);
    assert.deepEqual(result.calls.audits, []);
    assert.deepEqual(result.calls.processes, []);
    const routing = JSON.parse(
      await readFile(join(result.root, 'reports/mutation/routing.json'), 'utf8'),
    );
    assert.equal(routing.cacheReason, 'native-baseline-corrupt-or-unauditable');
  });

test('own-PR fallback rejects a main envelope from a different authenticated SHA', async (t) => {
  const result = await fixture(t, {
    cache: 'corrupt',
    mainCache: 'valid',
    env: { MUTATION_PR_CACHE_RESTORED: 'true', MUTATION_BASELINE_SHA: 'd'.repeat(40) },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.route, 'route=full-sharded\n');
  assert.deepEqual(result.calls.reads, ['pr:42:7', 'd'.repeat(40)]);
  assert.deepEqual(result.calls.audits, []);
  assert.deepEqual(result.calls.processes, []);
  const routing = JSON.parse(
    await readFile(join(result.root, 'reports/mutation/routing.json'), 'utf8'),
  );
  assert.equal(routing.cacheReason, 'native-baseline-incompatible');
});

test('own-PR fallback rechecks current audit and fails closed for both reports', async (t) => {
  const result = await fixture(t, {
    cache: 'valid',
    cacheReport: prReport,
    mainCache: 'valid',
    auditFailure: true,
    env: { MUTATION_PR_CACHE_RESTORED: 'true' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.route, 'route=full-sharded\n');
  assert.deepEqual(result.calls.reads, ['pr:42:7', commit]);
  assert.deepEqual(
    result.calls.audits.map(({ value }) => value),
    [prReport, mainReport],
  );
  assert.ok(result.calls.audits.every(({ options }) => options.nativeReuse === true));
  assert.deepEqual(result.calls.processes, []);
  assert.deepEqual(result.calls.promotions, []);
  await assert.rejects(readFile(join(result.root, 'reports/mutation/audit.json')), {
    code: 'ENOENT',
  });
});

for (const options of [{ args: ['--full'] }, { nodeOptions: true }, { inputFailure: true }])
  test(`forced paths never reuse own-PR or main fallback: ${JSON.stringify(options)}`, async (t) => {
    const result = await fixture(t, {
      cache: 'corrupt',
      mainCache: 'valid',
      env: { MUTATION_PR_CACHE_RESTORED: 'true' },
      ...options,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.calls.reads, []);
    assert.deepEqual(result.calls.workingReports, []);
    if (options.args) {
      assert.equal(result.route, '');
      assert.deepEqual(result.calls.processes[1].args, ['run', '--force']);
      const audit = JSON.parse(
        await readFile(join(result.root, 'reports/mutation/audit.json'), 'utf8'),
      );
      assert.equal(audit.execution.mode, 'full');
      assert.equal(audit.execution.baselineCommit, null);
      assert.equal(audit.execution.baselinePR, null);
    } else {
      assert.equal(result.route, 'route=full-sharded\n');
      assert.deepEqual(result.calls.processes, []);
    }
    assert.deepEqual(result.calls.promotions, []);
  });

test('native failure after own-PR fallback never launches a second campaign', async (t) => {
  const result = await fixture(t, {
    cache: 'corrupt',
    mainCache: 'valid',
    strykerFailure: true,
    env: { MUTATION_PR_CACHE_RESTORED: 'true' },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.route, 'route=native\n');
  assert.deepEqual(result.calls.reads, ['pr:42:7', commit]);
  assert.equal(result.calls.discovery, 1);
  assert.deepEqual(
    result.calls.processes.map(({ args }) => args),
    [['run', '--no-fsModuleCache'], ['run']],
  );
  assert.deepEqual(result.calls.workingReports, [mainReport]);
  assert.deepEqual(result.calls.promotions, []);
  for (const path of [BASELINE, PR_BASELINE, 'reports/mutation/audit.json'])
    await assert.rejects(readFile(join(result.root, path)), { code: 'ENOENT' });
});

test('current report audit rejection after own-PR fallback prevents promotion', async (t) => {
  const result = await fixture(t, {
    cache: 'corrupt',
    mainCache: 'valid',
    executionReport: { ...report, valid: false },
    env: { MUTATION_PR_CACHE_RESTORED: 'true' },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.route, 'route=native\n');
  assert.deepEqual(result.calls.workingReports, [mainReport]);
  assert.equal(result.calls.processes.length, 2);
  assert.deepEqual(result.calls.promotions, []);
  assert.ok(result.messages.some((message) => message.includes('audit rejected report')));
  for (const path of [BASELINE, PR_BASELINE, 'reports/mutation/audit.json'])
    await assert.rejects(readFile(join(result.root, path)), { code: 'ENOENT' });
});

test('cold main push runs native full and promotes the trusted sequential report', async (t) => {
  const result = await fixture(t, {
    env: { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.route, 'route=native\n');
  assert.equal(result.calls.discovery, 1);
  assert.deepEqual(
    result.calls.processes.map(({ args }) => args),
    [
      ['run', '--no-fsModuleCache'],
      ['run', '--force'],
    ],
  );
  assert.deepEqual(result.calls.promotions, [commit]);
});

for (const env of [
  { GITHUB_ACTIONS: '' },
  { GITHUB_EVENT_NAME: 'pull_request_target' },
  { GITHUB_EVENT_NAME: 'workflow_dispatch' },
  { GITHUB_REF: 'refs/pull/7/head' },
  { GITHUB_REPOSITORY_ID: '' },
  { GITHUB_OUTPUT: '' },
])
  test(`invalid routing context fails before execution: ${JSON.stringify(env)}`, async (t) => {
    const result = await fixture(t, { env });
    assert.equal(result.exitCode, 1);
    assert.equal(result.route, '');
    assert.equal(result.calls.discovery, 0);
    assert.deepEqual(result.calls.processes, []);
    assert.deepEqual(result.calls.promotions, []);
  });

for (const options of [
  { outputFailure: true },
  { outputFailure: true, cache: 'valid' },
  { diagnosticFailure: true },
  { staleProof: true },
])
  test(`routing prerequisite failure stops without a route: ${JSON.stringify(options)}`, async (t) => {
    const result = await fixture(t, options);
    assert.equal(result.exitCode, 1);
    assert.equal(result.route, '');
    assert.equal(result.calls.discovery, 0);
    assert.deepEqual(result.calls.processes, []);
    assert.deepEqual(result.calls.promotions, []);
    assert.equal(result.calls.ended, 1);
  });

test('warm execution failure cannot fall back to sharded execution', async (t) => {
  const result = await fixture(t, { cache: 'valid', processFailure: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.route, 'route=native\n');
  assert.equal(result.calls.discovery, 1);
  assert.equal(result.calls.processes.length, 1);
  assert.deepEqual(result.calls.promotions, []);
});

test('standalone full and cache-key preserve their behavior without routing output', async (t) => {
  const full = await fixture(t, { args: ['--full'], cache: 'valid' });
  assert.equal(full.exitCode, 0);
  assert.equal(full.route, '');
  assert.equal(full.calls.discovery, 1);
  assert.deepEqual(full.calls.processes[1].args, ['run', '--force']);
  assert.deepEqual(full.calls.promotions, []);
  const cacheKey = await fixture(t, { args: ['--cache-key'] });
  assert.equal(cacheKey.exitCode, 0);
  assert.equal(cacheKey.route, '');
  assert.deepEqual(cacheKey.messages, [key]);
  assert.equal(cacheKey.calls.discovery, 0);
  assert.equal(cacheKey.calls.ended, 0);
  assert.deepEqual(cacheKey.calls.processes, []);
});

test('the ordinary non-opt-in cold runner still executes native full', async (t) => {
  const result = await fixture(t, { args: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.route, '');
  assert.equal(result.calls.discovery, 1);
  assert.deepEqual(result.calls.processes[1].args, ['run', '--force']);
  assert.deepEqual(result.calls.promotions, ['pr:42:7']);
});

test('parallel fallback cannot be combined with standalone modes or scope arguments', async (t) => {
  for (const args of [
    ['--parallel-fallback', '--full'],
    ['--parallel-fallback', '--cache-key'],
    ['--parallel-fallback', '--mutate=src/mp3/example.ts'],
  ]) {
    const result = await fixture(t, { args });
    assert.equal(result.exitCode, 1);
    assert.equal(result.route, '');
    assert.equal(result.calls.discovery, 0);
    assert.deepEqual(result.calls.processes, []);
  }
});

test('unreadable baseline diagnostics remain a miss and do not call the report audit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-unreadable-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, BASELINE), { recursive: true });
  const result = await readCache(root, key, commit, () =>
    assert.fail('must not audit unreadable data'),
  );
  assert.deepEqual(result, { report: null, reason: 'native-baseline-unreadable' });
});
