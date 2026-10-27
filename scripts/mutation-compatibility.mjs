import { sha256 } from './mutation-policy.mjs';
import { posix } from 'node:path';
import { executionIsolation } from './mutation-execution-guard.mjs';
import { runtimeDependencyPaths } from './mutation-runtime-inputs.mjs';
import { assertReviewedRuntime } from './mutation-runtime-witness.mjs';
import { CI_WORKFLOW, mutationWorkflowInput } from './mutation-workflow-inputs.mjs';

export const sourceInput = (path) =>
  /\.[cm]?[jt]sx?$/.test(path) ||
  /(^|\/)(?:tsconfig[^/]*|package)\.json$/.test(path) ||
  path === 'stryker.config.json' ||
  path === CI_WORKFLOW;
export const parserInput = (path) => /^src\/mp3\/.*\.ts$/.test(path) && !path.endsWith('.d.ts');
export const mutableInput = (path) => /^(src|tests)\/.*\.ts$/.test(path) && !path.endsWith('.d.ts');
const passiveDocument = (path) =>
  (path !== 'docs/mutation-review.md' && /^docs\/.*\.md$/.test(path)) ||
  [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'TODO.md',
    'GLOSSARY.md',
    'CHANGELOG.md',
    '.github/copilot-instructions.md',
  ].includes(path);
const unrelatedTooling = (path) =>
  path === 'scripts/release-smoke-process.mjs' || /^scripts\/[^/]+\.test\.mjs$/.test(path);
const passiveSastInput = (path) =>
  path === '.semgrep.yml' || /^tests\/semgrep\/[^/]+\.fixture$/.test(path);
const variablePathInput = (path) =>
  passiveDocument(path) ||
  unrelatedTooling(path) ||
  passiveSastInput(path) ||
  (mutableInput(path) && !parserInput(path));

function compatibleFile(entry, inputs, runtime) {
  const [path] = entry;
  if (path === CI_WORKFLOW) {
    const source = inputs.sources?.[path];
    if (typeof source !== 'string' || sha256(source) !== entry.at(-1))
      throw new Error('Unauthenticated mutation workflow source');
    return [...entry.slice(0, -1), sha256(JSON.stringify(mutationWorkflowInput(source)))];
  }
  return !runtime.has(path) && (mutableInput(path) || path === 'mutation-equivalents.json')
    ? [...entry.slice(0, -1), null]
    : entry;
}

// This is only a comparison key, never an authorization to reuse. Callers must
// authenticate both source inventories and establish execution isolation first.
export function compatibilityInputs(inputs) {
  const runtime = runtimeDependencyPaths(new Map(Object.entries(inputs.sources ?? {})));
  const rest = { ...inputs };
  delete rest.sources;
  return {
    ...rest,
    files: inputs.files
      .filter(([path]) => runtime.has(path) || !variablePathInput(path))
      .map((entry) => compatibleFile(entry, inputs, runtime)),
  };
}

export function authenticatedSources(inputs) {
  const paths = inputs.files.map(([path]) => path);
  if (
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path ||
        path.includes('\\') ||
        path.startsWith('/') ||
        path.startsWith('../') ||
        path !== posix.normalize(path),
    )
  )
    throw new Error('Noncanonical or duplicate mutation input paths');
  const entries = inputs.files.filter(([path]) => sourceInput(path));
  const sources = inputs.sources;
  const expected = new Set(entries.map(([path]) => path));
  if (
    !sources ||
    Object.keys(sources).length !== entries.length ||
    Object.keys(sources).some((path) => !expected.has(path))
  )
    throw new Error('Incomplete authenticated dependency sources');
  for (const [path, , hash] of entries) {
    if (typeof sources[path] !== 'string' || sha256(sources[path]) !== hash)
      throw new Error(`Dependency source/input mismatch: ${path}`);
  }
  return new Map(Object.entries(sources));
}

export function reuseContext(inputs) {
  const files = authenticatedSources(inputs);
  assertReviewedRuntime(files);
  const inventory = new Map(inputs.files.map(([path]) => [path, null]));
  const isolation = executionIsolation(new Map([...inventory, ...files]));
  if (!isolation.supported) throw new Error(`Unsupported execution isolation: ${isolation.reason}`);
  return { files, testFiles: isolation.testFiles };
}

export function assertCompatibleModes(before, after) {
  const old = new Map(before.files.map(([path, mode]) => [path, mode]));
  for (const [path, mode] of after.files) {
    if (old.has(path) ? old.get(path) !== mode : variablePathInput(path) && mode !== 0o644)
      throw new Error(`Mutation input mode changed or unsupported: ${path}`);
  }
}

export function changedInputPaths(before, after) {
  const old = new Map(before.files.map(([path, ...identity]) => [path, JSON.stringify(identity)]));
  const current = new Map(
    after.files.map(([path, ...identity]) => [path, JSON.stringify(identity)]),
  );
  return [...new Set([...old.keys(), ...current.keys()])]
    .filter((path) => old.get(path) !== current.get(path))
    .sort();
}
