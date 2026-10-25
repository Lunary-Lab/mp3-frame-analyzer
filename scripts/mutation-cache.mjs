import { execFileSync, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  readFile,
  readdir,
  readlink,
  realpath,
  lstat,
  mkdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, win32 } from 'node:path';
import { arch, platform, release, version } from 'node:os';
import { sha256 } from './mutation-policy.mjs';
import { testWitnesses } from './mutation-impact.mjs';

export const CACHE_SCHEMA = 2;
export const CACHE_DIRECTORY = '.cache/mutation/validated';
export const WORKING_REPORT = '.cache/mutation/working.json';

// No arbitrary inherited variables (including credentials) reach test code.
// New supported inputs must be added here AND to the invalidation tests.
export function mutationEnvironment(env = process.env) {
  const names = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'CI',
    'NODE_OPTIONS',
    'PROPERTY_PATH',
    'ASSESSMENT_SAMPLE_PATH',
  ];
  return {
    ...Object.fromEntries(
      names.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
    ),
    NODE_ENV: 'test',
    PROPERTY_SEED: env.PROPERTY_SEED ?? '20261024',
    NO_COLOR: '1',
  };
}

const generated = new Set([
  '.git',
  'node_modules',
  '.cache',
  '.stryker-tmp',
  'reports',
  'coverage',
  'dist',
  'release',
  '.tmp',
  '.fuzz-corpus',
]);
export function isMutationInput(path) {
  if (generated.has(path.split('/')[0])) return false;
  if (/^fuzz\/(crashes|tmp)(\/|$)/.test(path)) return false;
  // Markdown can be executable test data too. Do not guess relevance from
  // extension or location: even documentation edits invalidate this cache.
  return true;
}

export function isContainedRelativePath(path) {
  const normalized = path.replaceAll('\\', '/');
  return (
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    normalized !== '..' &&
    !normalized.startsWith('../')
  );
}

async function fileInventory(root, { dependencies = false } = {}) {
  const result = [];
  const realRoot = await realpath(root);
  const runtimeCaches = new Set(['.cache', '.vite', '.vite-temp', '.vitest', '.vitest-cache']);
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      if (dependencies ? runtimeCaches.has(name.split('/')[0]) : !isMutationInput(name)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink()) {
        if (!dependencies) throw new Error(`Mutation input must not be a symlink: ${name}`);
        const target = relative(realRoot, await realpath(path)).replaceAll('\\', '/');
        if (!isContainedRelativePath(target) || runtimeCaches.has(target.split('/')[0])) {
          throw new Error(`Dependency symlink leaves fingerprinted inputs: ${name}`);
        }
        result.push([name, 'link', await readlink(path)]);
      } else if (entry.isFile())
        result.push([name, (await lstat(path)).mode & 0o777, sha256(await readFile(path))]);
      else throw new Error(`Unsupported mutation input: ${name}`);
    }
  }
  await visit(root);
  return result;
}

async function encoderIdentity(env) {
  const available = spawnSync('lame', ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  if (available.error?.code === 'ENOENT') return { available: false };
  if (available.status !== 0) throw new Error('Cannot establish LAME tool identity');
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const path = join(directory, process.platform === 'win32' ? 'lame.exe' : 'lame');
    try {
      // POSIX PATH lookup skips non-executable shadows. Hash exactly the
      // executable selected by the same search, not the first readable file.
      await access(path, constants.X_OK);
      if (!(await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink()) continue;
      const bytes = await readFile(path);
      const resolved = spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
      if (
        resolved.status !== 0 ||
        resolved.stdout !== available.stdout ||
        resolved.stderr !== available.stderr
      )
        throw new Error('LAME resolution changed during fingerprinting');
      return { available: true, sha256: sha256(bytes), version: resolved.stdout + resolved.stderr };
    } catch (error) {
      if (!['ENOENT', 'EISDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('Cannot locate the LAME executable used by tests');
}

export function fingerprint(inputs) {
  return sha256(JSON.stringify(inputs));
}

export async function mutationInputs(root, env = mutationEnvironment()) {
  // Actual installed bytes, not just declared versions: local dependency edits
  // cannot silently reuse a lockfile-matching result. Runtime caches are excluded.
  const dependencies = await fileInventory(join(root, 'node_modules'), { dependencies: true });
  const sample = env.ASSESSMENT_SAMPLE_PATH;
  return {
    schemaVersion: CACHE_SCHEMA,
    files: await fileInventory(root),
    dependenciesSha256: fingerprint(dependencies),
    dependencyRootLink: (await lstat(join(root, 'node_modules'))).isSymbolicLink()
      ? await readlink(join(root, 'node_modules'))
      : null,
    environmentSha256: fingerprint(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
    externalSampleSha256: sample ? sha256(await readFile(sample)) : null,
    runtime: {
      node: process.version,
      versions: process.versions,
      nodeBinarySha256: sha256(await readFile(process.execPath)),
      npm: execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
        encoding: 'utf8',
        env,
      }).trim(),
      os: { platform: platform(), arch: arch(), release: release(), version: version() },
      runnerImage: process.env.ImageOS ?? null,
      runnerImageVersion: process.env.ImageVersion ?? null,
      libc: process.report.getReport().header.glibcVersionRuntime ?? null,
      encoder: await encoderIdentity(env),
    },
  };
}

export function inventory(report) {
  return Object.entries(report.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, record]) =>
      record.mutants
        .map((mutant) => [
          file,
          sha256(record.source),
          mutant.mutatorName,
          mutant.replacement,
          mutant.location,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
}

export const mutableInput = (path) =>
  (/^src\/mp3\/.*\.ts$/.test(path) && !path.endsWith('.d.ts')) ||
  /^tests\/.*\.test\.ts$/.test(path);

export function globalFingerprint(inputs) {
  return fingerprint({
    ...inputs,
    files: inputs.files.map((entry) =>
      mutableInput(entry[0]) || entry[0] === 'mutation-equivalents.json'
        ? [...entry.slice(0, -1), null]
        : entry,
    ),
  });
}

export function samePolicyExceptContext(before, current) {
  return (
    JSON.stringify({ ...before, contextSha256: null }) ===
    JSON.stringify({ ...current, contextSha256: null })
  );
}

export function createCache(report, inputs, summary, policy = null, sourceCommit = null) {
  const reportText = JSON.stringify(report);
  return {
    reportText,
    manifest: {
      schemaVersion: CACHE_SCHEMA,
      completed: true,
      inputs,
      inputsHash: fingerprint(inputs),
      policy,
      sourceCommit,
      reportSha256: sha256(reportText),
      inventorySha256: fingerprint(inventory(report)),
      total: summary.total,
      audit: summary,
    },
  };
}

export function validateCache(manifest, reportText, inputs, audit, policy) {
  if (manifest?.schemaVersion !== CACHE_SCHEMA || manifest.completed !== true)
    throw new Error('Invalid or incomplete cache manifest');
  if (manifest.inputsHash !== fingerprint(manifest.inputs))
    throw new Error('Corrupt cached input manifest');
  if (globalFingerprint(manifest.inputs) !== globalFingerprint(inputs))
    throw new Error('Global mutation inputs changed');
  if (policy && !samePolicyExceptContext(manifest.policy, policy))
    throw new Error('Equivalence policy changed beyond parser context');
  if (manifest.reportSha256 !== sha256(reportText)) throw new Error('Corrupt cached report');
  const report = JSON.parse(reportText);
  const authenticated = { ...report.files, ...report.testFiles };
  const oldInputs = new Map(manifest.inputs.files.map((entry) => [entry[0], entry.at(-1)]));
  for (const entry of inputs.files) {
    if (
      mutableInput(entry[0]) &&
      oldInputs.get(entry[0]) !== entry.at(-1) &&
      !authenticated[entry[0]]
    )
      throw new Error(`Changed input lacks authenticated prior source: ${entry[0]}`);
  }
  const baselineSources = new Map(
    Object.entries(report.files).map(([file, record]) => [file, record.source]),
  );
  const baselineHashes = new Map(manifest.inputs.files.map((entry) => [entry[0], entry.at(-1)]));
  for (const [file, record] of Object.entries({ ...report.files, ...report.testFiles })) {
    if (baselineHashes.get(file) !== sha256(record.source))
      throw new Error('Cached report/input source mismatch');
  }
  const summary = audit(report, manifest.policy, baselineSources);
  if (
    fingerprint(inventory(report)) !== manifest.inventorySha256 ||
    summary.total !== manifest.total ||
    JSON.stringify(summary) !== JSON.stringify(manifest.audit)
  )
    throw new Error('Cached inventory or audit mismatch');
  return report;
}

export async function readCache(root, inputs, audit, policy) {
  try {
    const path = join(root, CACHE_DIRECTORY);
    for (const name of ['manifest.json', 'report.json']) {
      if (!(await lstat(join(path, name))).isFile())
        throw new Error('Cache entry must be a regular file');
    }
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    const reportText = await readFile(join(path, 'report.json'), 'utf8');
    return {
      report: validateCache(manifest, reportText, inputs, audit, policy),
      manifest,
      reason: 'validated baseline',
    };
  } catch (error) {
    return { report: null, reason: error.code === 'ENOENT' ? 'cache missing' : error.message };
  }
}

export async function promoteCache(root, report, inputs, summary, policy = null) {
  const directory = join(root, CACHE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  let sourceCommit = null;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* Non-Git functional fixtures remain local-only. */
  }
  const { manifest, reportText } = createCache(report, inputs, summary, policy, sourceCommit);
  // Manifest last: interruption between writes is a digest mismatch (safe miss).
  await writeFile(join(directory, 'report.json.tmp'), reportText);
  await rename(join(directory, 'report.json.tmp'), join(directory, 'report.json'));
  await writeFile(join(directory, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(join(directory, 'manifest.json.tmp'), join(directory, 'manifest.json'));
}

export function executionSummary(report, eligible = null, baseline = null) {
  const key = (file, source, mutant) =>
    JSON.stringify([file, sha256(source), mutant.mutatorName, mutant.replacement, mutant.location]);
  const old = new Map();
  if (
    baseline &&
    Object.entries(baseline.files).every(
      ([file, record]) => report.files[file]?.source === record.source,
    ) &&
    fingerprint(inventory(report)) !== fingerprint(inventory(baseline))
  )
    throw new Error('Full mutant inventory changed despite identical parser sources');
  if (eligible)
    for (const [file, record] of Object.entries(eligible.files))
      for (const mutant of record.mutants) old.set(key(file, record.source, mutant), mutant);
  const oldTests = eligible ? testWitnesses(eligible) : new Map();
  const currentTests = testWitnesses(report);
  let executed = 0;
  let reused = 0;
  for (const [file, record] of Object.entries(report.files)) {
    for (const mutant of record.mutants) {
      // Real hook kills can finish in zero ms. Missing duration, not zero,
      // identifies Stryker10.1.1 reuse. Timeouts still require positive evidence.
      if (Object.hasOwn(mutant, 'duration')) {
        if (
          !Number.isFinite(mutant.duration) ||
          (mutant.status === 'Timeout' ? mutant.duration <= 0 : mutant.duration < 0)
        )
          throw new Error(`No fresh execution: invalid duration for mutant ${mutant.id}`);
        executed++;
      } else {
        const before = old.get(key(file, record.source, mutant));
        const valid = new Set(
          (before?.killedBy ?? []).map((id) => oldTests.get(id)?.identity).filter(Boolean),
        );
        if (
          !before ||
          before.static ||
          before.status !== 'Killed' ||
          mutant.status !== 'Killed' ||
          before.testsCompleted !== mutant.testsCompleted ||
          !(mutant.killedBy ?? []).some((id) => valid.has(currentTests.get(id)?.identity))
        )
          throw new Error(
            `No fresh execution or validated killing-test witness for mutant ${mutant.id}`,
          );
        reused++;
      }
    }
  }
  return { executed, reused, total: executed + reused };
}
