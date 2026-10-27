import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { restoreBaseline as restoreVerifiedBaseline } from './restore-mutation-baseline.mjs';
import { BASELINE_LIMITS, trustedAncestry } from './mutation-baseline-selection.mjs';
import { sha256 } from './mutation-policy.mjs';
// These fixtures isolate authenticated transport; production defaults validate full cache inputs.
const restoreBaseline = (root, repo, sha, api, options = {}) =>
  restoreVerifiedBaseline(root, repo, sha, api, {
    currentHead: sha,
    validateCandidate: () => true,
    ...options,
  });

const repository = 'owner/project';
const anchor = 'a'.repeat(40);
const ancestor = 'b'.repeat(40);
function run(id, commit = anchor) {
  return {
    id,
    repository: { id: 1, full_name: repository },
    head_repository: { id: 1, full_name: repository },
    head_sha: commit,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/ci.yml',
    run_attempt: 1,
  };
}
async function fixture(root, producer) {
  const report = '{"files":{}}';
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      sourceCommit: producer.head_sha,
      completed: true,
      reportSha256: sha256(report),
    }),
  );
  await writeFile(join(root, 'report.json'), report);
  execFileSync('zip', ['-q', 'baseline.zip', 'manifest.json', 'report.json'], { cwd: root });
  const bytes = await readFile(join(root, 'baseline.zip'));
  return {
    bytes,
    artifact: {
      id: producer.id + 100,
      name: 'validated-mutation-baseline',
      expired: false,
      size_in_bytes: bytes.length,
      digest: 'sha256:' + sha256(bytes),
      workflow_run: {
        id: producer.id,
        head_sha: producer.head_sha,
        head_branch: 'main',
        repository_id: 1,
        head_repository_id: 1,
      },
    },
  };
}

test('a successful exact-base run without its artifact does not hide another valid exact-base run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-ancestor-'));
  try {
    const producer = run(12);
    const { bytes, artifact } = await fixture(root, producer);
    const api = (path) => {
      if (path.includes('/workflows/'))
        return JSON.stringify({ workflow_runs: [run(99), producer] });
      if (path.includes('/runs/99/artifacts')) return JSON.stringify({ artifacts: [] });
      if (path.includes('/runs/12/artifacts')) return JSON.stringify({ artifacts: [artifact] });
      if (path.endsWith('/zip')) return bytes;
      if (path.endsWith('/runs/12')) return JSON.stringify(producer);
      throw new Error('Unexpected test request');
    };
    const result = await restoreBaseline(root, repository, anchor, api);
    assert.equal(result.restored, true);
    assert.equal(result.runId, producer.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a running exact-base campaign can use a compatible authenticated ancestor without waiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-ancestor-'));
  try {
    const producer = run(12, ancestor);
    const { bytes, artifact } = await fixture(root, producer);
    const api = (path) => {
      if (path.includes('/workflows/'))
        return JSON.stringify({ workflow_runs: path.includes('head_sha=') ? [] : [producer] });
      if (path.includes('/compare/'))
        return JSON.stringify({
          status: 'ahead',
          ahead_by: 1,
          behind_by: 0,
          base_commit: { sha: ancestor },
          merge_base_commit: { sha: ancestor },
        });
      if (path.endsWith('/artifacts?per_page=100'))
        return JSON.stringify({ artifacts: [artifact] });
      if (path.endsWith('/zip')) return bytes;
      if (path.endsWith('/runs/12')) return JSON.stringify(producer);
      throw new Error('Unexpected test request');
    };
    const result = await restoreBaseline(root, repository, anchor, api);
    assert.equal(result.restored, true);
    assert.equal(result.sourceCommit, ancestor);
    assert.equal(result.anchorCommit, anchor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const comparison = {
  status: 'ahead',
  ahead_by: 1,
  behind_by: 0,
  base_commit: { sha: ancestor },
  merge_base_commit: { sha: ancestor },
};
function transport(runs, fixtures = [], options = {}) {
  const calls = [];
  const api = (path) => {
    calls.push(path);
    if (path.includes('/workflows/'))
      return JSON.stringify({
        workflow_runs: path.includes('head_sha=')
          ? runs.filter((item) => item.head_sha === anchor)
          : runs,
      });
    if (path.includes('/compare/')) return JSON.stringify(options.comparison ?? comparison);
    const artifactList = path.match(/\/runs\/(\d+)\/artifacts/);
    if (artifactList)
      return JSON.stringify({
        artifacts: fixtures
          .filter((item) => item.artifact.workflow_run.id === Number(artifactList[1]))
          .map((item) => item.artifact),
      });
    const download = path.match(/\/artifacts\/(\d+)\/zip$/);
    if (download) return fixtures.find((item) => item.artifact.id === Number(download[1])).bytes;
    const producer = runs.find((item) => path.endsWith(`/runs/${item.id}`));
    if (producer) return JSON.stringify(options.finalRun ?? producer);
    throw new Error('Unexpected test request');
  };
  return { api, calls };
}
async function isolated(callback) {
  const root = await mkdtemp(join(tmpdir(), 'baseline-selection-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function assertNoState(root) {
  for (const path of ['validated/report.json', 'provenance.json'])
    await assert.rejects(readFile(join(root, '.cache/mutation', path)), { code: 'ENOENT' });
}

test('ancestry requires authenticated exact merge/base identities, direction and counts', () => {
  assert.equal(trustedAncestry(comparison, ancestor, anchor), true);
  assert.equal(
    trustedAncestry({ ...comparison, status: 'identical', ahead_by: 0 }, ancestor, ancestor),
    true,
  );
  for (const patch of [
    { status: 'behind' },
    { status: 'diverged' },
    { status: 'identical' },
    { status: undefined },
    { head_commit: { sha: ancestor } },
    { head_commit: null },
    { base_commit: undefined },
    { merge_base_commit: undefined },
    { base_commit: { sha: anchor } },
    { merge_base_commit: { sha: anchor } },
    { ahead_by: 0 },
    { ahead_by: undefined },
    { ahead_by: '1' },
    { ahead_by: 1.5 },
    { behind_by: 1 },
    { behind_by: undefined },
    { behind_by: '0' },
  ])
    assert.equal(trustedAncestry({ ...comparison, ...patch }, ancestor, anchor), false);
  for (const malformed of [null, undefined, {}, [], 'ahead'])
    assert.equal(trustedAncestry(malformed, ancestor, anchor), false);
});

test('a nonancestor successful main run cannot authorize an artifact download', async () => {
  await isolated(async (root) => {
    const producer = run(12, ancestor);
    const archive = await fixture(root, producer);
    for (const status of ['behind', 'diverged', 'identical']) {
      const mock = transport([producer], [archive], { comparison: { ...comparison, status } });
      const result = await restoreBaseline(root, repository, anchor, mock.api);
      assert.equal(result.restored, false);
      assert.ok(result.reasonCodes.includes('ancestry-rejected'));
      assert.equal(mock.calls.filter((path) => path.includes('/artifacts')).length, 0);
      await assertNoState(root);
    }
  });
});

test('an incompatible authenticated candidate is skipped for another valid candidate', async () => {
  await isolated(async (root) => {
    const first = run(13);
    const second = run(12, ancestor);
    const mock = transport(
      [first, second],
      [await fixture(root, first), await fixture(root, second)],
    );
    const validated = [];
    const result = await restoreBaseline(root, repository, anchor, mock.api, {
      validateCandidate: ({ manifest }) => {
        validated.push(manifest.sourceCommit);
        if (manifest.sourceCommit === anchor) throw new Error('secret incompatibility detail');
        return true;
      },
    });
    assert.equal(result.restored, true);
    assert.equal(result.sourceCommit, ancestor);
    assert.deepEqual(validated, [anchor, ancestor]);
    assert.ok(result.reasonCodes.includes('compatibility-rejected'));
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });
});

test('cancelled/incomplete/foreign runs and malformed source SHAs never reach download', async () => {
  await isolated(async (root) => {
    for (const patch of [
      { status: 'in_progress' },
      { conclusion: 'cancelled' },
      { conclusion: 'failure' },
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { path: '.github/workflows/other.yml' },
      { head_repository: { id: 2, full_name: repository } },
      { run_attempt: 0 },
      { head_sha: 'b'.repeat(39) },
      { head_sha: 'B'.repeat(40) },
      { head_sha: '0'.repeat(40) },
    ]) {
      const mock = transport([{ ...run(12), ...patch }]);
      const result = await restoreBaseline(root, repository, anchor, mock.api);
      assert.equal(result.restored, false);
      assert.ok(result.reasonCodes.includes('run-provenance-rejected'));
      assert.equal(
        mock.calls.some((path) => path.endsWith('/zip')),
        false,
      );
    }
  });
});

test('a run rerun or cancelled during download cannot commit provenance', async () => {
  await isolated(async (root) => {
    const producer = run(12);
    const archive = await fixture(root, producer);
    for (const patch of [
      { run_attempt: 2 },
      { status: 'in_progress' },
      { conclusion: 'cancelled' },
    ]) {
      const mock = transport([producer], [archive], { finalRun: { ...producer, ...patch } });
      const result = await restoreBaseline(root, repository, anchor, mock.api);
      assert.equal(result.restored, false);
      assert.ok(result.reasonCodes.includes('run-changed-during-restore'));
      await assertNoState(root);
    }
  });
});

test('a retained artifact records the observed successful run attempt, not its producing attempt', async () => {
  await isolated(async (root) => {
    const producer = run(12);
    const archive = await fixture(root, producer);
    const observed = { ...producer, run_attempt: 2 };
    const mock = transport([observed], [archive]);
    const result = await restoreBaseline(root, repository, anchor, mock.api);
    assert.equal(result.restored, true);
    assert.equal(result.observedRunAttempt, 2);
    assert.equal(Object.hasOwn(result, 'runAttempt'), false);
    assert.equal(result.artifactId, archive.artifact.id);
    assert.equal(result.archiveDigest, archive.artifact.digest);
    const provenance = JSON.parse(await readFile(join(root, '.cache/mutation/provenance.json')));
    assert.equal(provenance.observedRunAttempt, 2);
    assert.equal(Object.hasOwn(provenance, 'runAttempt'), false);
  });
});

test('candidate and download bounds cannot be inflated by repeated or incompatible runs', async () => {
  await isolated(async (root) => {
    const runs = Array.from({ length: 12 }, (_, index) => run(index + 1));
    const missing = transport([runs[0], runs[0], ...runs.slice(1)]);
    const result = await restoreBaseline(root, repository, anchor, missing.api);
    assert.equal(result.restored, false);
    assert.ok(result.reasonCodes.includes('restore-budget-exhausted'));
    assert.equal(
      missing.calls.filter((path) => path.includes('/artifacts')).length,
      BASELINE_LIMITS.candidates,
    );
    const fixtures = [];
    for (const producer of runs.slice(0, 5)) fixtures.push(await fixture(root, producer));
    const incompatible = transport(runs.slice(0, 5), fixtures);
    const exhausted = await restoreBaseline(root, repository, anchor, incompatible.api, {
      validateCandidate: () => false,
    });
    assert.equal(exhausted.restored, false);
    assert.ok(exhausted.reasonCodes.includes('restore-budget-exhausted'));
    assert.equal(
      incompatible.calls.filter((path) => path.endsWith('/zip')).length,
      BASELINE_LIMITS.downloads,
    );
    await assertNoState(root);
  });
});

test('a cumulative wall-clock budget prevents slow transport from turning a miss into a long wait', async () => {
  await isolated(async (root) => {
    let now = 0;
    let calls = 0;
    const api = () => {
      calls++;
      now = BASELINE_LIMITS.elapsedMs;
      return JSON.stringify({ workflow_runs: [] });
    };
    const result = await restoreBaseline(root, repository, anchor, api, { now: () => now });
    assert.equal(result.restored, false);
    assert.ok(result.reasonCodes.includes('restore-budget-exhausted'));
    assert.equal(calls, 1);
    await assertNoState(root);
  });
});

test('concurrent restore does not erase an active mutation invocation state', async () => {
  await isolated(async (root) => {
    await mkdir(join(root, '.cache/mutation/validated'), { recursive: true });
    await mkdir(join(root, '.cache/mutation/run.lock'));
    const report = join(root, '.cache/mutation/validated/report.json');
    const provenance = join(root, '.cache/mutation/provenance.json');
    await writeFile(report, 'active report');
    await writeFile(provenance, 'active provenance');
    const result = await restoreBaseline(root, repository, anchor, () => {
      throw new Error('must not request');
    });
    assert.deepEqual(result.reasonCodes, ['workspace-busy']);
    assert.equal(await readFile(report, 'utf8'), 'active report');
    assert.equal(await readFile(provenance, 'utf8'), 'active provenance');
  });
});

test('production restore does not silently reduce to transport-only validation', async () => {
  await isolated(async (root) => {
    const producer = run(12);
    const mock = transport([producer], [await fixture(root, producer)]);
    const result = await restoreVerifiedBaseline(root, repository, anchor, mock.api, {
      currentHead: anchor,
    });
    assert.equal(result.restored, false);
    assert.deepEqual(result.reasonCodes, ['restore-inputs-or-io-unavailable']);
    assert.equal(mock.calls.length, 0);
    await assertNoState(root);
  });
});

test('fixed-entry native ZIP reads ignore inherited unzip and zipinfo option variables', async () => {
  await isolated(async (root) => {
    const producer = run(12);
    const mock = transport([producer], [await fixture(root, producer)]);
    for (const name of ['UNZIP', 'UNZIPOPT', 'ZIPINFO', 'ZIPINFOOPT']) {
      const previous = process.env[name];
      try {
        process.env[name] = '--invalid-baseline-isolation-option';
        assert.equal(
          (await restoreBaseline(root, repository, anchor, mock.api)).restored,
          true,
          name,
        );
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
  });
});

test('a corrupt candidate archive does not hide a later authenticated compatible candidate', async () => {
  await isolated(async (root) => {
    const first = run(13);
    const second = run(12, ancestor);
    const corrupt = await fixture(root, first);
    corrupt.bytes = Buffer.from('corrupt archive');
    const mock = transport([first, second], [corrupt, await fixture(root, second)]);
    const result = await restoreBaseline(root, repository, anchor, mock.api);
    assert.equal(result.restored, true);
    assert.equal(result.sourceCommit, ancestor);
    assert.ok(result.reasonCodes.includes('archive-rejected'));
  });
});

test('shallow checkout history is not guessed or fetched: authenticated compare is required', async () => {
  await isolated(async (root) => {
    const origin = join(root, 'origin');
    const checkout = join(root, 'checkout');
    await mkdir(origin);
    const git = (args, cwd = origin) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init', '-q']);
    await writeFile(join(origin, 'input'), 'old');
    git(['add', 'input']);
    const commitArgs = [
      '-c',
      'user.name=Mutation fixture',
      '-c',
      'user.email=mutation@example.invalid',
      'commit',
      '-qm',
    ];
    git([...commitArgs, 'old']);
    const old = git(['rev-parse', 'HEAD']);
    await writeFile(join(origin, 'input'), 'new');
    git(['add', 'input']);
    git([...commitArgs, 'new']);
    const current = git(['rev-parse', 'HEAD']);
    git(['clone', '-q', '--depth=1', `file://${origin}`, checkout]);
    assert.equal(git(['rev-parse', '--is-shallow-repository'], checkout), 'true');
    assert.throws(() => git(['cat-file', '-e', old], checkout));
    const producer = run(12, old);
    const archive = await fixture(checkout, producer);
    for (const verified of [true, false]) {
      const mock = transport([producer], [archive], {
        comparison: verified
          ? { ...comparison, base_commit: { sha: old }, merge_base_commit: { sha: old } }
          : {},
      });
      const result = await restoreBaseline(checkout, repository, current, mock.api);
      assert.equal(result.restored, verified);
      if (verified) assert.equal(result.sourceCommit, old);
      else await assertNoState(checkout);
      assert.equal(git(['rev-parse', '--is-shallow-repository'], checkout), 'true');
      assert.throws(() => git(['cat-file', '-e', old], checkout));
    }
  });
});

test('force-push or forged event anchors cannot authorize reuse on an unrelated tested head', async () => {
  await isolated(async (root) => {
    const currentHead = 'c'.repeat(40);
    for (const status of ['behind', 'diverged', 'identical']) {
      const mock = transport([run(12)], [], {
        comparison: {
          ...comparison,
          status,
          base_commit: { sha: anchor },
          merge_base_commit: { sha: ancestor },
        },
      });
      const result = await restoreBaseline(root, repository, anchor, mock.api, { currentHead });
      assert.equal(result.restored, false);
      assert.ok(result.reasonCodes.includes('anchor-ancestry-rejected'));
      assert.deepEqual(mock.calls, [
        `repos/${repository}/compare/${anchor}...${currentHead}?per_page=1`,
      ]);
      await assertNoState(root);
    }
  });
});

test('PR synthetic merge ancestry is authenticated once before ancestor baseline selection', async () => {
  await isolated(async (root) => {
    const currentHead = 'c'.repeat(40);
    const producer = run(12, ancestor);
    const mock = transport([producer], [await fixture(root, producer)]);
    let anchorChecks = 0;
    const api = (path, ...args) => {
      if (path === `repos/${repository}/compare/${anchor}...${currentHead}?per_page=1`) {
        anchorChecks++;
        return JSON.stringify({
          ...comparison,
          base_commit: { sha: anchor },
          merge_base_commit: { sha: anchor },
        });
      }
      return mock.api(path, ...args);
    };
    const result = await restoreBaseline(root, repository, anchor, api, { currentHead });
    assert.equal(result.restored, true);
    assert.equal(result.sourceCommit, ancestor);
    assert.equal(result.anchorCommit, anchor);
    assert.equal(result.testedCommit, currentHead);
    assert.equal(anchorChecks, 1);
  });
});

test('missing or malformed current-tested-head provenance cannot downgrade to anchor-only restore', async () => {
  await isolated(async (root) => {
    for (const currentHead of [
      undefined,
      null,
      '',
      '0'.repeat(40),
      'C'.repeat(40),
      'c'.repeat(39),
    ]) {
      let calls = 0;
      const result = await restoreBaseline(
        root,
        repository,
        anchor,
        () => {
          calls++;
        },
        { currentHead },
      );
      assert.equal(result.restored, false);
      assert.deepEqual(result.reasonCodes, ['invalid-tested-head']);
      assert.equal(calls, 0);
      await assertNoState(root);
    }
  });
});

test('the production CLI binds GITHUB_SHA instead of defaulting to the event anchor', async () => {
  await isolated(async (root) => {
    const script = fileURLToPath(new URL('./restore-mutation-baseline.mjs', import.meta.url));
    for (const [head, reason] of [
      [undefined, 'invalid-tested-head'],
      [anchor, 'restore-inputs-or-io-unavailable'],
    ]) {
      const env = {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: repository,
        MUTATION_BASE_SHA: anchor,
      };
      if (head) env.GITHUB_SHA = head;
      const output = execFileSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
      const result = JSON.parse(output);
      assert.equal(result.restored, false);
      assert.deepEqual(result.reasonCodes, [reason]);
    }
  });
});
