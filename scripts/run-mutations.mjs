import { createWriteStream } from 'node:fs';
import { runMutationProcess } from './mutation-process.mjs';
import { appendFile, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMutations, sourceContext } from './mutation-policy.mjs';
import { verifyParserTestDiscovery } from './parser-test-discovery.mjs';
import {
  WORKING_REPORT,
  BASELINE,
  PR_BASELINE,
  mutationEnvironment,
  mutationInputs,
  fingerprint,
  readCache,
  promoteCache,
  executionSummary,
  pullRequestIdentity,
} from './mutation-cache.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'reports/mutation');

async function parserSources(directory = join(root, 'src/mp3')) {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const pair of await parserSources(path)) result.set(...pair);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.set(relative(root, path).replaceAll('\\', '/'), await readFile(path, 'utf8'));
    }
  }
  return result;
}

let log;
let locked = false;
const lock = join(root, '.cache/mutation/run.lock');
mutationRun: try {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !['--full', '--cache-key', '--parallel-fallback'].includes(arg)) ||
    args.length > 1
  ) {
    throw new Error(
      'Only --full, --cache-key or --parallel-fallback is supported; narrowing mutation scope is forbidden',
    );
  }
  if (!args.includes('--cache-key')) {
    await mkdir(dirname(lock), { recursive: true });
    try {
      await mkdir(lock);
      locked = true;
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(
          'Another mutation invocation holds .cache/mutation/run.lock; do not share working state',
          { cause: error },
        );
      throw error;
    }
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    log = createWriteStream(join(output, 'execution.log'));
  }
  const env = mutationEnvironment();
  let inputCaptureError = null;
  const inputs = await mutationInputs(root, env).catch((error) => {
    inputCaptureError = error.code ?? 'unsupported-input';
    console.warn(`Mutation input capture unavailable (${inputCaptureError}); running full.`);
    return null;
  });
  const inputsHash = inputs && fingerprint(inputs);
  if (args.includes('--cache-key')) {
    console.log(inputsHash ?? 'unavailable');
  } else {
    // Only the current invocation writes reports. Working/partial incremental
    // state is never restored or saved by GitHub Actions.
    await rm(join(root, WORKING_REPORT), { force: true });
    const policy = JSON.parse(await readFile(join(root, 'mutation-equivalents.json'), 'utf8'));
    const sources = await parserSources();
    if (policy.contextSha256 !== sourceContext(sources)) {
      throw new Error(
        'Parser context changed: review equivalence proofs before rerunning mutations',
      );
    }
    const audit = (report, options) => auditMutations(report, policy, sources, options);
    const force = args.includes('--full') || Boolean(env.NODE_OPTIONS) || !inputsHash;
    const routingIdentity = pullRequestIdentity(process.env);
    const prIdentity = force ? null : routingIdentity;
    let sourceIdentity =
      prIdentity && process.env.MUTATION_PR_CACHE_RESTORED === 'true'
        ? prIdentity
        : process.env.GITHUB_ACTIONS === 'true'
          ? process.env.MUTATION_BASELINE_SHA
          : 'local';
    let cache = force
      ? { report: null, reason: 'native-full-required' }
      : await readCache(root, inputsHash, sourceIdentity, audit);
    if (
      !force &&
      !cache.report &&
      prIdentity &&
      sourceIdentity === prIdentity &&
      /^[a-f0-9]{40}$/.test(process.env.MUTATION_BASELINE_SHA ?? '')
    ) {
      sourceIdentity = process.env.MUTATION_BASELINE_SHA;
      cache = await readCache(root, inputsHash, sourceIdentity, audit);
    }
    await mkdir(dirname(join(root, WORKING_REPORT)), { recursive: true });
    if (cache.report) await writeFile(join(root, WORKING_REPORT), JSON.stringify(cache.report));
    // CI transport files are not proof of successful promotion by this invocation.
    // Keep the admitted native working copy, but only save freshly promoted envelopes.
    if (process.env.GITHUB_ACTIONS === 'true')
      for (const path of [BASELINE, PR_BASELINE]) await rm(join(root, path), { force: true });
    console.log(`Mutation cache: ${cache.reason}. Native Stryker owns result reuse.`);
    if (args.includes('--parallel-fallback')) {
      const mainPush =
        process.env.GITHUB_ACTIONS === 'true' &&
        process.env.GITHUB_EVENT_NAME === 'push' &&
        process.env.GITHUB_REF === 'refs/heads/main';
      if (!routingIdentity && !mainPush)
        throw new Error('Parallel fallback requires a hosted pull-request merge or main push');
      if (!process.env.GITHUB_OUTPUT) throw new Error('Parallel fallback requires GITHUB_OUTPUT');
      const route = routingIdentity && !cache.report ? 'full-sharded' : 'native';
      await writeFile(
        join(output, 'routing.json'),
        JSON.stringify(
          { route, cacheReason: cache.reason, inputsHash, inputCaptureError },
          null,
          2,
        ) + '\n',
      );
      await appendFile(process.env.GITHUB_OUTPUT, `route=${route}\n`);
      // Leave through finally so the shard handoff never retains the local lock.
      if (route === 'full-sharded') break mutationRun;
    }
    const discovery = await verifyParserTestDiscovery(root, env);
    await writeFile(join(output, 'discovery.json'), JSON.stringify(discovery, null, 2) + '\n');
    const started = performance.now();
    // A normal unmutated run is mandatory even for a 100% cache hit. Stryker
    // subsequently performs its own fresh discovery/coverage dry run as well.
    const vitest = join(
      dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
      'vitest.mjs',
    );
    await runMutationProcess(vitest, ['run', '--no-fsModuleCache'], env, log);
    const stryker = join(
      dirname(fileURLToPath(import.meta.resolve('@stryker-mutator/core/package.json'))),
      'bin/stryker.js',
    );
    await runMutationProcess(stryker, ['run', ...(!cache.report ? ['--force'] : [])], env, log);
    const report = JSON.parse(await readFile(join(output, 'mutation.json'), 'utf8'));
    const summary = audit(report, { nativeReuse: Boolean(cache.report) });
    for (const [file, record] of Object.entries(report.testFiles)) {
      if (record.source !== (await readFile(join(root, file), 'utf8')))
        throw new Error(`Stale test source in report: ${file}`);
    }
    const execution = executionSummary(report, Boolean(cache.report));
    // Do not bless a run whose inputs changed while it was executing.
    const finalInputs = await mutationInputs(root, env).catch(() => null);
    await writeFile(join(output, 'inputs-before.json'), JSON.stringify(inputs, null, 2) + '\n');
    await writeFile(join(output, 'inputs-after.json'), JSON.stringify(finalInputs, null, 2) + '\n');
    if (inputsHash && (!finalInputs || fingerprint(finalInputs) !== inputsHash))
      throw new Error('Mutation inputs changed during execution');
    const runSummary = {
      ...summary,
      execution: {
        ...execution,
        mode: cache.report ? 'incremental' : 'full',
        cacheReason: cache.reason,
        baselineCommit:
          cache.report && /^[a-f0-9]{40}$/.test(sourceIdentity) ? sourceIdentity : null,
        baselinePR: cache.report && sourceIdentity?.startsWith('pr:') ? sourceIdentity : null,
        elapsedMs: Math.round(performance.now() - started),
        inputsHash,
        inputCaptureError,
      },
    };
    await writeFile(join(output, 'audit.json'), JSON.stringify(runSummary, null, 2) + '\n');
    await writeFile(join(output, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
    // Promotion is last, after clean process exits, complete scope/equivalence
    // audit, freshness, and execution accounting. Failed/partial runs cannot win.
    if (
      inputsHash &&
      !env.NODE_OPTIONS &&
      (process.env.GITHUB_ACTIONS !== 'true' ||
        (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main'))
    )
      await promoteCache(
        root,
        report,
        inputsHash,
        process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_SHA : 'local',
      );
    if (inputsHash && prIdentity) await promoteCache(root, report, inputsHash, prIdentity);
    console.log(
      `Mutants executed this invocation: ${execution.executed}; reused validated results: ${execution.reused}.`,
    );
    console.log(`Raw mutation score: ${summary.rawScore.toFixed(2)}%`);
    console.log(
      `Adjusted mutation score: ${summary.adjustedScore}% ` +
        `(${summary.adjustedDetected}/${summary.adjustedTotal}; required: 100%)`,
    );
    console.log(
      `Killed: ${summary.killed}; timed out: ${summary.timedOut}; ` +
        `reviewed equivalent survivors: ${summary.equivalent}.`,
    );
    console.log(
      `Reviewed equivalent timeouts: ${summary.timedOutEquivalents.length}` +
        (summary.timedOutEquivalents.length ? ` (${summary.timedOutEquivalents.join(', ')})` : '') +
        '.',
    );
    console.log('Every parser module is included. Raw report: reports/mutation/mutation.json');
  }
} catch (error) {
  if (locked) await rm(join(output, 'audit.json'), { force: true });
  console.error(`Mutation verification FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  log?.end();
  if (locked) await rm(lock, { recursive: true, force: true });
}
