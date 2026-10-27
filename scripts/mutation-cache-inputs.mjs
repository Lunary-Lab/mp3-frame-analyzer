import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './mutation-policy.mjs';

export const fingerprint = (value) => sha256(JSON.stringify(value));
const passive = /^(README|AGENTS|GLOSSARY|CHANGELOG|CLAUDE|TODO)\.md$/;
const architectureOnly = new Set([
  'scripts/runtime-architecture.mjs',
  'scripts/runtime-architecture-rule.mjs',
  'scripts/runtime-architecture.test.mjs',
  'scripts/runtime-architecture-native.test.mjs',
]);
export function isMutationInput(path) {
  if (path === 'docs/mutation-review.md') return true;
  return !(
    path === 'node_modules' ||
    passive.test(path) ||
    /^docs\/.*\.md$/.test(path) ||
    path.startsWith('governance/') ||
    path.startsWith('tests/runtime-architecture/') ||
    architectureOnly.has(path) ||
    path === '.github/workflows/ci.yml' ||
    path === '.github/copilot-instructions.md'
  );
}

// This is a declared deterministic-input contract, not JavaScript purity analysis.
// CI installs the exact lockfile with npm ci --ignore-scripts; installed-package
// edits and undeclared external reads are unsupported for result caching.
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

export async function mutationInputs(
  root,
  env,
  runtime = {
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    runnerImage: [process.env.ImageOS ?? null, process.env.ImageVersion ?? null],
  },
) {
  // Git supplies the tracked and nonignored untracked inventory; no custom graph,
  // dependency resolver, historical source snapshots or node_modules traversal.
  const paths = execFileSync('git', ['ls-files', '-cz', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  paths.push('.env', '.env.local', '.env.test', '.env.test.local');
  const files = [];
  for (const path of [...new Set(paths)].filter(isMutationInput).sort()) {
    const full = join(root, path);
    const stat = await lstat(full).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile()) throw new Error('Unsupported nonregular mutation input');
    files.push([path, stat.mode & 0o777, sha256(await readFile(full))]);
  }
  return {
    files,
    runtime,
    environmentSha256: fingerprint(env),
    externalSampleSha256: env.ASSESSMENT_SAMPLE_PATH
      ? sha256(await readFile(env.ASSESSMENT_SAMPLE_PATH))
      : null,
  };
}
