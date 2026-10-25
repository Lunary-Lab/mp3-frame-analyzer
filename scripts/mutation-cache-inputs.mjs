import { execFileSync, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, readlink, realpath, lstat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, win32 } from 'node:path';
import { arch, platform, release, version } from 'node:os';
import { sha256 } from './mutation-policy.mjs';

export const CACHE_SCHEMA = 2;

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

async function fingerprintEncoder(path, env, available) {
  // POSIX PATH lookup skips non-executable shadows. Hash exactly the
  // executable selected by the same search, not the first readable file.
  await access(path, constants.X_OK);
  if (!(await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink()) return null;
  const bytes = await readFile(path);
  const resolved = spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  if (
    resolved.status !== 0 ||
    resolved.stdout !== available.stdout ||
    resolved.stderr !== available.stderr
  )
    throw new Error('LAME resolution changed during fingerprinting');
  return { available: true, sha256: sha256(bytes), version: resolved.stdout + resolved.stderr };
}

async function encoderIdentity(env) {
  const available = spawnSync('lame', ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  if (available.error?.code === 'ENOENT') return { available: false };
  if (available.status !== 0) throw new Error('Cannot establish LAME tool identity');
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const path = join(directory, process.platform === 'win32' ? 'lame.exe' : 'lame');
    try {
      const identity = await fingerprintEncoder(path, env, available);
      if (identity) return identity;
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
