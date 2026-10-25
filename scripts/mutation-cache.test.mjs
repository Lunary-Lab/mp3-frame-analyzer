import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  CACHE_DIRECTORY,
  createCache,
  executionSummary,
  fingerprint,
  inventory,
  isMutationInput,
  isContainedRelativePath,
  mutationEnvironment,
  mutationInputs,
  promoteCache,
  readCache,
  validateCache,
} from './mutation-cache.mjs';

import { planReuse } from './mutation-impact.mjs';
import { sha256 } from './mutation-policy.mjs';
const inputHash = {
  files: [
    ['src/mp3/example.ts', 420, sha256('// +')],
    ['tests/example.test.ts', 420, sha256("import '../src/mp3/example.js';")],
  ],
};
function fixture() {
  const mutant = {
    id: '0',
    status: 'Killed',
    testsCompleted: 1,
    killedBy: ['0'],
    duration: 5,
    mutatorName: 'ArithmeticOperator',
    replacement: '-',
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  };
  const report = {
    files: { 'src/mp3/example.ts': { source: '// +', mutants: [mutant] } },
    testFiles: {
      'tests/example.test.ts': {
        source: "import '../src/mp3/example.js';",
        tests: [{ id: '0', name: 'example', location: { start: { line: 1, column: 1 } } }],
      },
    },
  };
  const summary = { status: 'passed', total: 1 };
  return { report, mutant, summary, audit: () => summary };
}

test('all project inputs including Markdown invalidate; only generated outputs are exempt', () => {
  const included = [
    'src/mp3/new.ts',
    'src/support.ts',
    'tests/new.test.ts',
    'tests/helpers/factory.ts',
    'tests/fixtures/input.mp3',
    'tests/__snapshots__/x.snap',
    'fuzz/corpus/input',
    'scripts/generate-fixtures.mjs',
    'stryker.config.json',
    'vitest.config.ts',
    'vitest.mutation.config.ts',
    'tsconfig.json',
    'package.json',
    'package-lock.json',
    '.nvmrc',
    '.npmrc',
    '.env',
    '.github/workflows/ci.yml',
    'mutation-equivalents.json',
    'docs/config.json',
    'docs/fixture.md',
    'README.md',
    'docs/testing.md',
    'unexpected-file',
  ];
  for (const path of included) assert.equal(isMutationInput(path), true, path);
  for (const path of [
    'node_modules/x',
    '.cache/x',
    'reports/mutation/audit.json',
    'dist/x',
    '.git/HEAD',
  ])
    assert.equal(isMutationInput(path), false, path);
});

test('actual file changes, additions, removal, Markdown, modes and dependency edits change the fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-inputs-'));
  try {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'node_modules/dependency.js'), 'original');
    await writeFile(join(root, 'tests/test.ts'), 'original');
    const env = mutationEnvironment();
    const hash = () => mutationInputs(root, env).then(fingerprint);
    const before = await hash();
    await writeFile(join(root, 'README.md'), 'unrelated documentation');
    assert.notEqual(await hash(), before, 'Markdown is not assumed irrelevant');
    await rm(join(root, 'README.md'));
    const originalMode = (await lstat(join(root, 'tests/test.ts'))).mode & 0o777;
    await chmod(join(root, 'tests/test.ts'), 0o755);
    assert.notEqual(await hash(), before, 'file mode');
    await chmod(join(root, 'tests/test.ts'), originalMode);
    await writeFile(join(root, 'tests/test.ts'), 'changed');
    assert.notEqual(await hash(), before, 'changed test');
    await writeFile(join(root, 'tests/test.ts'), 'original');
    await writeFile(join(root, 'tests/added.test.ts'), 'new test');
    assert.notEqual(await hash(), before, 'added test');
    await rm(join(root, 'tests/added.test.ts'));
    assert.equal(await hash(), before);
    await rm(join(root, 'tests/test.ts'));
    assert.notEqual(await hash(), before, 'removed test');
    await writeFile(join(root, 'tests/test.ts'), 'original');
    await writeFile(join(root, 'node_modules/dependency.js'), 'changed with unchanged lockfile');
    assert.notEqual(await hash(), before, 'actual installed dependency');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('all supported environment options are bound; unknown/secret variables never reach tests', () => {
  const base = mutationEnvironment({ PATH: '/bin' });
  assert.equal(base.PROPERTY_SEED, '20261024');
  for (const key of [
    'PROPERTY_SEED',
    'PROPERTY_PATH',
    'ASSESSMENT_SAMPLE_PATH',
    'NODE_OPTIONS',
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
  ]) {
    assert.notEqual(
      fingerprint(mutationEnvironment({ PATH: '/bin', [key]: 'changed' })),
      fingerprint(base),
      key,
    );
  }
  assert.deepEqual(
    mutationEnvironment({
      PATH: '/bin',
      UNKNOWN_OPTION: 'x',
      GITHUB_TOKEN: 'secret',
      NODE_ENV: 'production',
      NO_COLOR: '0',
    }),
    base,
  );
});

test('Node/npm/OS/architecture/runtime/tool versions and policy identity all invalidate', () => {
  const base = {
    runtime: {
      node: '24.22.1',
      npm: '11.19.0',
      os: 'linux',
      arch: 'x64',
      libc: '2.41',
      nodeBinarySha256: 'node',
      versions: { v8: '13' },
      runnerImageVersion: '1',
      encoder: { sha256: 'lame' },
    },
    dependenciesSha256: 'deps',
    files: [['mutation-equivalents.json', 'policy']],
  };
  for (const key of Object.keys(base.runtime)) {
    const changed = structuredClone(base);
    changed.runtime[key] = 'changed';
    assert.notEqual(fingerprint(changed), fingerprint(base), key);
  }
  for (const key of ['dependenciesSha256', 'files']) {
    const changed = structuredClone(base);
    changed[key] = 'changed';
    assert.notEqual(fingerprint(changed), fingerprint(base), key);
  }
});

test('missing/corrupt/wrong-version/incomplete/stale cache fails closed', () => {
  const f = fixture();
  const good = createCache(f.report, inputHash, f.summary);
  assert.deepEqual(validateCache(good.manifest, good.reportText, inputHash, f.audit), f.report);
  for (const edit of [
    (m) => {
      m.schemaVersion = 99;
    },
    (m) => {
      m.completed = false;
    },
    (m) => {
      delete m.completed;
    },
    (m) => {
      m.inputsHash = 'stale';
    },
    (m) => {
      m.reportSha256 = 'bad';
    },
    (m) => {
      m.inventorySha256 = 'bad';
    },
    (m) => {
      m.total = 0;
    },
    (m) => {
      m.audit.status = 'failed';
    },
  ]) {
    const m = structuredClone(good.manifest);
    edit(m);
    assert.throws(() => validateCache(m, good.reportText, inputHash, f.audit));
  }
  assert.throws(() => validateCache(good.manifest, '{', inputHash, f.audit));
  assert.throws(() =>
    validateCache(good.manifest, good.reportText, inputHash, () => {
      throw new Error('Incomplete outcome');
    }),
  );
});

test('cache publication and partial/corrupt write recovery never trust working state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-cache-'));
  const f = fixture();
  try {
    assert.equal((await readCache(root, inputHash, f.audit)).report, null);
    await promoteCache(root, f.report, inputHash, f.summary);
    assert.deepEqual((await readCache(root, inputHash, f.audit)).report, f.report);
    await writeFile(join(root, '.cache/mutation/working.json'), '{"partial":true}');
    assert.deepEqual((await readCache(root, inputHash, f.audit)).report, f.report);
    const manifest = await readFile(join(root, CACHE_DIRECTORY, 'manifest.json'), 'utf8');
    await writeFile(join(root, CACHE_DIRECTORY, 'report.json'), '{"partial":true}');
    assert.equal((await readCache(root, inputHash, f.audit)).report, null);
    assert.equal(await readFile(join(root, CACHE_DIRECTORY, 'manifest.json'), 'utf8'), manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeouts and static mutants must rerun; the original report is never rewritten', () => {
  const f = fixture();
  f.report.files['src/mp3/example.ts'].mutants.push(
    { ...f.mutant, id: '1', status: 'Timeout' },
    { ...f.mutant, id: '2', static: true },
  );
  const before = structuredClone(f.report);
  const ready = planReuse(
    f.report,
    new Map(
      Object.entries({ ...f.report.files, ...f.report.testFiles }).map(([file, record]) => [
        file,
        record.source,
      ]),
    ),
  );
  assert.deepEqual({ eligible: ready.eligible, rerun: ready.rerun }, { eligible: 1, rerun: 2 });
  assert.deepEqual(ready.report.files['src/mp3/example.ts'].mutants, [f.mutant]);
  assert.deepEqual(f.report, before);
});

test('execution accounting rejects invented fresh results, incomplete inventories and timeout reuse', () => {
  const f = fixture();
  const current = structuredClone(f.report);
  assert.deepEqual(executionSummary(current), { executed: 1, reused: 0, total: 1 });
  delete current.files['src/mp3/example.ts'].mutants[0].duration;
  assert.throws(() => executionSummary(current), /No fresh execution/);
  assert.deepEqual(executionSummary(current, f.report), { executed: 0, reused: 1, total: 1 });
  f.mutant.status = 'Timeout';
  current.files['src/mp3/example.ts'].mutants[0].status = 'Timeout';
  assert.throws(() => executionSummary(current, f.report), /No fresh execution/);
  f.report.files['src/mp3/example.ts'].mutants.push({ ...f.mutant, replacement: '*' });
  assert.throws(() => executionSummary(current, f.report, f.report), /inventory changed/);
});

test('inventory identities do not depend on concurrent completion order or numeric mutant IDs', () => {
  const f = fixture();
  f.report.files['src/mp3/example.ts'].mutants.push({ ...f.mutant, id: '1', replacement: '*' });
  const reverse = structuredClone(f.report);
  reverse.files['src/mp3/example.ts'].mutants.reverse().forEach((m) => {
    m.id = 'different';
  });
  assert.deepEqual(inventory(reverse), inventory(f.report));
});

test('external sample bytes and encoder availability/version/binary bytes are fingerprinted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-external-'));
  try {
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, 'tools'));
    const sample = join(root, 'sample.mp3');
    await writeFile(sample, 'first');
    const env = mutationEnvironment({
      ...process.env,
      ASSESSMENT_SAMPLE_PATH: sample,
      PATH: join(root, 'tools') + ':' + process.env.PATH,
    });
    const before = await mutationInputs(root, env);
    assert.equal(before.runtime.node, process.version);
    assert.equal(before.runtime.versions.v8, process.versions.v8);
    assert.equal(typeof before.runtime.npm, 'string');
    await writeFile(sample, 'second');
    const after = await mutationInputs(root, env);
    assert.notEqual(after.externalSampleSha256, before.externalSampleSha256);
    if (process.platform !== 'win32') {
      await writeFile(join(root, 'tools/lame'), '#!/bin/sh\nprintf "test encoder 1\\n"\n', {
        mode: 0o755,
      });
      const available = await mutationInputs(root, env);
      assert.equal(available.runtime.encoder.available, true);
      await writeFile(join(root, 'tools/lame'), '#!/bin/sh\nprintf "test encoder 2\\n"\n', {
        mode: 0o755,
      });
      const updated = await mutationInputs(root, env);
      assert.notEqual(updated.runtime.encoder.version, available.runtime.encoder.version);
      assert.notEqual(updated.runtime.encoder.sha256, available.runtime.encoder.sha256);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linked dependencies cannot escape the fingerprinted tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-links-'));
  try {
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, 'external'));
    await writeFile(join(root, 'external/index.js'), 'first');
    await symlink(join(root, 'external'), join(root, 'node_modules/linked'), 'dir');
    await assert.rejects(mutationInputs(root), /Dependency symlink leaves fingerprinted inputs/);
    await writeFile(join(root, 'external/index.js'), 'changed');
    await assert.rejects(mutationInputs(root), /Dependency symlink leaves fingerprinted inputs/);
    await rm(join(root, 'node_modules/linked'));
    await mkdir(join(root, 'node_modules/package'));
    await writeFile(join(root, 'node_modules/package/index.js'), 'first');
    await symlink('package', join(root, 'node_modules/linked'), 'dir');
    const before = fingerprint(await mutationInputs(root));
    await writeFile(join(root, 'node_modules/package/index.js'), 'changed');
    assert.notEqual(fingerprint(await mutationInputs(root)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependency containment rejects different Windows drives, UNC and parent traversal', () => {
  for (const path of [
    '../external',
    '..',
    '..\\external',
    '/absolute',
    'D:/external',
    '\\\\server\\share\\dependency',
    win32.relative('C:\\repo\\node_modules', 'D:\\external'),
  ])
    assert.equal(isContainedRelativePath(path), false, path);
  for (const path of ['package/index.js', 'package\\index.js', '.bin/../package'])
    assert.equal(isContainedRelativePath(path), true, path);
});

test('changing the root dependency link invalidates even identical target bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-root-link-'));
  try {
    for (const name of ['a', 'b']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'index.js'), 'same');
    }
    await symlink(join(root, 'a'), join(root, 'node_modules'), 'dir');
    const before = await mutationInputs(root);
    await rm(join(root, 'node_modules'));
    await symlink(join(root, 'b'), join(root, 'node_modules'), 'dir');
    const after = await mutationInputs(root);
    assert.equal(after.dependenciesSha256, before.dependenciesSha256);
    assert.notEqual(after.dependencyRootLink, before.dependencyRootLink);
    assert.notEqual(fingerprint(after), fingerprint(before));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'encoder identity skips a non-executable PATH shadow',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutation-encoder-shadow-'));
    try {
      for (const dir of ['node_modules', 'first', 'second']) await mkdir(join(root, dir));
      await writeFile(join(root, 'first/lame'), 'not executable', { mode: 0o600 });
      await writeFile(join(root, 'second/lame'), '#!/bin/sh\nprintf "same encoder version\\n"\n', {
        mode: 0o700,
      });
      const env = mutationEnvironment({
        ...process.env,
        PATH: join(root, 'first') + ':' + join(root, 'second') + ':' + process.env.PATH,
      });
      const before = await mutationInputs(root, env);
      await writeFile(
        join(root, 'second/lame'),
        '#!/bin/sh\n# binary changed but version identical\nprintf "same encoder version\\n"\n',
        { mode: 0o700 },
      );
      const after = await mutationInputs(root, env);
      assert.equal(after.runtime.encoder.version, before.runtime.encoder.version);
      assert.notEqual(after.runtime.encoder.sha256, before.runtime.encoder.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('explicit zero-ms fresh kills are valid; missing duration and zero-ms timeouts are not', () => {
  const f = fixture();
  f.mutant.duration = 0;
  assert.equal(executionSummary(f.report).executed, 1);
  f.mutant.status = 'Timeout';
  assert.throws(() => executionSummary(f.report), /No fresh execution/);
  delete f.mutant.duration;
  assert.throws(() => executionSummary(f.report), /No fresh execution/);
});

test('present invalid durations cannot masquerade as validated reuse', () => {
  const f = fixture();
  for (const duration of [null, -1, NaN, Infinity, '1', undefined]) {
    const current = structuredClone(f.report);
    current.files['src/mp3/example.ts'].mutants[0].duration = duration;
    assert.throws(() => executionSummary(current, f.report), /invalid duration/);
  }
});
