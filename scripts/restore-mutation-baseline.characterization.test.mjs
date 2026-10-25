import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { restoreBaseline, trustedArtifact, trustedRun } from './restore-mutation-baseline.mjs';
import { sha256 } from './mutation-policy.mjs';

const repository = 'owner/project';
const commit = 'a'.repeat(40);
const run = {
  id: 12,
  repository: { id: 1, full_name: repository },
  head_repository: { id: 1, full_name: repository },
  head_sha: commit,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/ci.yml',
};
const artifact = {
  id: 34,
  name: 'validated-mutation-baseline',
  expired: false,
  size_in_bytes: 50,
  digest: 'sha256:' + 'b'.repeat(64),
  workflow_run: {
    id: run.id,
    head_sha: commit,
    head_branch: 'main',
    repository_id: 1,
    head_repository_id: 1,
  },
};
const miss = {
  restored: false,
  reason: 'No authenticated compatible baseline; full run required',
};

test('run identity gates reject missing, nonpositive, fractional and unsafe repository IDs', () => {
  for (const value of [undefined, null, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal(trustedRun({ ...run, id: value }, repository, commit), false);
    assert.equal(
      trustedRun({ ...run, repository: { ...run.repository, id: value } }, repository, commit),
      false,
    );
  }
  assert.equal(trustedRun({ ...run, repository: undefined }, repository, commit), false);
  assert.equal(trustedRun({ ...run, head_repository: undefined }, repository, commit), false);
  assert.equal(trustedRun({ ...run, head_repository: null }, repository, commit), false);
  assert.equal(trustedRun(run, 'different/project', commit), false);
  assert.equal(trustedRun(run, repository, 'b'.repeat(40)), false);
});

test('artifact size bounds and lowercase SHA-256 format remain exact', () => {
  for (const value of [undefined, null, 0, -1, 0.5, Infinity, 32 * 1024 * 1024 + 1, '50'])
    assert.equal(trustedArtifact({ ...artifact, size_in_bytes: value }, run), false);
  for (const value of [1, 32 * 1024 * 1024])
    assert.equal(trustedArtifact({ ...artifact, size_in_bytes: value }, run), true);
  for (const value of ['', undefined, 'sha256:' + 'B'.repeat(64), 'sha256:' + 'b'.repeat(63)])
    assert.equal(trustedArtifact({ ...artifact, digest: value }, run), false);
  assert.equal(trustedArtifact({ ...artifact, workflow_run: undefined }, run), false);
  assert.equal(trustedArtifact({ ...artifact, workflow_run: null }, run), false);
});

async function seedStaleState(root) {
  const cache = join(root, '.cache/mutation/validated');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'report.json'), 'stale');
  await writeFile(join(root, '.cache/mutation/provenance.json'), 'stale');
}

async function assertCleared(root) {
  await assert.rejects(readFile(join(root, '.cache/mutation/validated/report.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(readFile(join(root, '.cache/mutation/provenance.json')), {
    code: 'ENOENT',
  });
}

test('invalid baseline coordinates clear stale state before any API call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-characterization-'));
  try {
    for (const [repo, sha] of [
      [undefined, commit],
      ['owner', commit],
      ['owner/project/extra', commit],
      [repository, undefined],
      [repository, '0'.repeat(40)],
      [repository, 'A'.repeat(40)],
      [repository, 'a'.repeat(39)],
    ]) {
      await seedStaleState(root);
      let calls = 0;
      const api = () => {
        calls++;
        throw new Error('must not request');
      };
      assert.deepEqual(await restoreBaseline(root, repo, sha, api), miss);
      assert.equal(calls, 0);
      await assertCleared(root);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function archive(root, report, patch = {}) {
  const manifest = JSON.stringify({
    sourceCommit: commit,
    completed: true,
    reportSha256: sha256(report),
    ...patch,
  });
  await writeFile(join(root, 'manifest.json'), manifest);
  await writeFile(join(root, 'report.json'), report);
  await rm(join(root, 'baseline.zip'), { force: true });
  execFileSync('zip', ['-q', 'baseline.zip', 'manifest.json', 'report.json'], { cwd: root });
  const bytes = await readFile(join(root, 'baseline.zip'));
  return {
    bytes,
    manifest,
    artifact: { ...artifact, size_in_bytes: bytes.length, digest: 'sha256:' + sha256(bytes) },
  };
}

function transport(fixture, runs = [run], artifacts = [fixture.artifact]) {
  const calls = [];
  return {
    calls,
    api(path, binary) {
      calls.push([path, binary]);
      if (path.includes('/workflows/')) return JSON.stringify({ workflow_runs: runs });
      if (path.endsWith('/zip')) return fixture.bytes;
      return JSON.stringify({ artifacts });
    },
  };
}

test('restore selects the first trusted run and exactly one trusted artifact in request order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-characterization-'));
  try {
    const fixture = await archive(root, '{"files":{}}');
    const { api, calls } = transport(
      fixture,
      [{ ...run, event: 'pull_request' }, run, { ...run, id: 99 }],
      [{ ...fixture.artifact, expired: true }, fixture.artifact],
    );
    const provenance = {
      sourceCommit: commit,
      runId: run.id,
      artifactId: artifact.id,
      archiveDigest: fixture.artifact.digest,
    };
    assert.deepEqual(await restoreBaseline(root, repository, commit, api), {
      restored: true,
      ...provenance,
    });
    assert.deepEqual(calls, [
      [
        `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&status=success&per_page=100`,
        undefined,
      ],
      [`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`, undefined],
      [`repos/${repository}/actions/artifacts/${artifact.id}/zip`, true],
    ]);
    assert.equal(
      await readFile(join(root, '.cache/mutation/validated/manifest.json'), 'utf8'),
      fixture.manifest,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, '.cache/mutation/provenance.json'), 'utf8')),
      provenance,
    );
    const duplicate = transport(fixture, [run], [fixture.artifact, fixture.artifact]);
    assert.deepEqual(await restoreBaseline(root, repository, commit, duplicate.api), miss);
    assert.equal(duplicate.calls.length, 2);
    await assertCleared(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest provenance, report digest and report JSON fail closed after authenticated ZIP transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-characterization-'));
  try {
    for (const [report, patch] of [
      ['{}', { sourceCommit: 'b'.repeat(40) }],
      ['{}', { completed: false }],
      ['{}', { completed: 1 }],
      ['{}', { reportSha256: '0'.repeat(64) }],
      ['not JSON', {}],
    ]) {
      const fixture = await archive(root, report, patch);
      await seedStaleState(root);
      const { api, calls } = transport(fixture);
      assert.deepEqual(await restoreBaseline(root, repository, commit, api), miss);
      assert.equal(calls.length, 3);
      await assertCleared(root);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
