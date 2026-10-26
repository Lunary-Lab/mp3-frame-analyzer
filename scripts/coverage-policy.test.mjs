import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import config from '../vitest.config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every production source file has all four 100% coverage thresholds without exclusions', () => {
  assert.deepEqual(config.test.coverage.include, ['src/**/*.ts']);
  assert.deepEqual(config.test.coverage.thresholds, {
    perFile: true,
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  });
  assert.equal(config.test.coverage.exclude, undefined);
});

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-coverage-policy-'));
  try {
    await mkdir(join(directory, 'src', 'nested'), { recursive: true });
    await mkdir(join(directory, 'tests'));
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(directory, 'vitest.config.ts'),
      await readFile(join(root, 'vitest.config.ts')),
    );
    await writeFile(join(directory, 'src', 'app.ts'), 'export const ready = true;\n');
    await writeFile(
      join(directory, 'src', 'nested', 'new-module.ts'),
      'export function classify(value: boolean) { return value ? "yes" : "no"; }\n',
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function coverage(directory) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', '--maxWorkers=1'],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('the real coverage runner rejects a newly added source file that no test imports', async () => {
  await fixture(async (directory) => {
    await writeFile(
      join(directory, 'tests', 'app.test.ts'),
      'import { expect, it } from "vitest"; import { ready } from "../src/app.js";\n' +
        'it("app is ready", () => expect(ready).toBe(true));\n',
    );
    const result = coverage(directory);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Coverage for lines \(0%\).*src\/nested\/new-module.ts/);
    assert.match(result.output, /Coverage for branches \(0%\).*src\/nested\/new-module.ts/);
  });
});

test('the real coverage runner accepts a fully exercised new source file without a config edit', async () => {
  await fixture(async (directory) => {
    await writeFile(
      join(directory, 'tests', 'app.test.ts'),
      'import { expect, it } from "vitest"; import { ready } from "../src/app.js";\n' +
        'import { classify } from "../src/nested/new-module.js";\n' +
        'it("both choices", () => { expect(ready).toBe(true);\n' +
        'expect(classify(true)).toBe("yes"); expect(classify(false)).toBe("no"); });\n',
    );
    const result = coverage(directory);
    assert.equal(result.status, 0, result.output);
    const lcov = await readFile(join(directory, 'coverage', 'lcov.info'), 'utf8');
    assert.match(lcov, /SF:src\/nested\/new-module.ts/);
  });
});
