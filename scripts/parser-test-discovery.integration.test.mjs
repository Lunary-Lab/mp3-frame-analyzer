import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifyParserTestDiscovery } from './parser-test-discovery.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const suite = "import { expect, it } from 'vitest'; it('discovered', () => expect(2).toBe(2));\n";
const ordinary =
  "export default { test: { include: ['tests/**/*.test.ts'], passWithNoTests: true } };\n";

function run(root) {
  const result = spawnSync(
    process.execPath,
    [
      join(project, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'vitest.mutation.config.ts',
    ],
    { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.error, undefined);
  return result;
}

test('native discovery includes future nested suites and rejects either narrowed config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parser-native-discovery-'));
  try {
    await mkdir(join(root, 'tests/mp3/future-module'), { recursive: true });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(root, 'vitest.config.ts'), ordinary);
    await cp(join(project, 'vitest.mutation.config.ts'), join(root, 'vitest.mutation.config.ts'));
    await mkdir(join(root, 'scripts'));
    await cp(
      join(project, 'scripts/mutation-fast-first-sequencer.mjs'),
      join(root, 'scripts/mutation-fast-first-sequencer.mjs'),
    );
    const mutation = await readFile(join(root, 'vitest.mutation.config.ts'), 'utf8');
    await writeFile(join(root, 'tests/server.test.ts'), "throw new Error('must not load');\n");
    await writeFile(join(root, 'tests/mp3/first.test.ts'), suite);
    assert.deepEqual((await verifyParserTestDiscovery(root)).parserFiles, [
      'tests/mp3/first.test.ts',
    ]);
    await writeFile(join(root, 'tests/mp3/future-module/unknown.test.ts'), suite);
    const expected = ['tests/mp3/first.test.ts', 'tests/mp3/future-module/unknown.test.ts'];
    assert.deepEqual((await verifyParserTestDiscovery(root)).parserFiles, expected);
    const active = run(root);
    assert.equal(active.status, 0, active.stdout + active.stderr);
    await writeFile(
      join(root, 'vitest.mutation.config.ts'),
      mutation.replace(
        'passWithNoTests: false,',
        "passWithNoTests: false, exclude: ['**/unknown.test.ts'],",
      ),
    );
    await assert.rejects(verifyParserTestDiscovery(root), /Mutation Vitest discovery differs/);
    await writeFile(join(root, 'vitest.mutation.config.ts'), mutation);
    await writeFile(
      join(root, 'vitest.config.ts'),
      ordinary.replace(
        'passWithNoTests: true',
        "passWithNoTests: true, exclude: ['**/unknown.test.ts']",
      ),
    );
    // A shared exclusion hides the future suite from BOTH native lists. The
    // filesystem ownership glob still catches it; agreement alone is not enough.
    await assert.rejects(verifyParserTestDiscovery(root), /Ordinary Vitest discovery/);
    await writeFile(join(root, 'vitest.config.ts'), ordinary);
    await rename(
      join(root, 'tests/mp3/first.test.ts'),
      join(root, 'tests/mp3/future-module/renamed.test.ts'),
    );
    assert.deepEqual((await verifyParserTestDiscovery(root)).parserFiles, [
      'tests/mp3/future-module/renamed.test.ts',
      'tests/mp3/future-module/unknown.test.ts',
    ]);
    await rm(join(root, 'tests/mp3/future-module'), { recursive: true });
    await assert.rejects(verifyParserTestDiscovery(root), /No parser test suites/);
    const empty = run(root);
    assert.equal(empty.status, 1, empty.stdout + empty.stderr);
    assert.match(empty.stdout + empty.stderr, /No test files found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
