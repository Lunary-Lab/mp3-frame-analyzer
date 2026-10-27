import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isMain } from './release-utils.mjs';

export const PARSER_TEST_GLOB = 'tests/mp3/**/*.test.ts';
const execute = promisify(execFile);
const slash = (path) => path.replaceAll('\\', '/');

function sortedUnique(paths) {
  assert.ok(Array.isArray(paths) && paths.every((path) => typeof path === 'string'));
  assert.equal(new Set(paths).size, paths.length, 'Duplicate native discovery entry');
  return paths.toSorted();
}

/** Directory ownership, not import/dependency analysis or a suite-name allowlist. */
export function assertParserTestDiscovery(expected, ordinary, mutation) {
  const owned = sortedUnique(expected);
  assert.ok(owned.length > 0, `No parser test suites match ${PARSER_TEST_GLOB}`);
  const all = sortedUnique(ordinary);
  const selected = sortedUnique(mutation);
  assert.deepEqual(
    all.filter((path) => path.startsWith('tests/mp3/') && path.endsWith('.test.ts')),
    owned,
    'Ordinary Vitest discovery does not include every mirrored parser suite',
  );
  assert.deepEqual(
    selected,
    owned,
    'Mutation Vitest discovery differs from parser directory ownership',
  );
  return { parserFiles: owned, ordinaryFileCount: all.length, mutationFileCount: selected.length };
}

async function nativeFiles(root, config, env) {
  const cli = join(
    dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
    'vitest.mjs',
  );
  const { stdout } = await execute(
    process.execPath,
    [cli, 'list', '--filesOnly', '--json', '--config', config, '--no-fsModuleCache'],
    { cwd: root, env, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout).map(({ file }) => slash(relative(root, file)));
}

export async function verifyParserTestDiscovery(root, env = process.env) {
  // Native filesystem glob supplies the declared ownership inventory; native
  // Vitest applies each actual config. Both narrowing either config and widening
  // the mutation selection beyond this directory fail before a campaign starts.
  const expected = (await Array.fromAsync(glob(PARSER_TEST_GLOB, { cwd: root }))).map(slash);
  assert.ok(expected.length > 0, `No parser test suites match ${PARSER_TEST_GLOB}`);
  const ordinary = await nativeFiles(root, 'vitest.config.ts', env);
  const mutation = await nativeFiles(root, 'vitest.mutation.config.ts', env);
  return assertParserTestDiscovery(expected, ordinary, mutation);
}

if (isMain(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  console.log(JSON.stringify(await verifyParserTestDiscovery(root), null, 2));
}
