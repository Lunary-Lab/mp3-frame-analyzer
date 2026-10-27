import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  restoreBaseline as restoreVerifiedBaseline,
  trustedRun,
  trustedArtifact,
  verifyArchive,
  verifyEntries,
} from './restore-mutation-baseline.mjs';
import { sha256 } from './mutation-policy.mjs';
// These fixtures isolate authenticated transport; production defaults validate full cache inputs.
const restoreBaseline = (root, repo, sha, api, options = {}) =>
  restoreVerifiedBaseline(root, repo, sha, api, {
    currentHead: sha,
    validateCandidate: () => true,
    ...options,
  });
const repo = 'owner/project';
const commit = 'a'.repeat(40);
const run = {
  id: 12,
  run_attempt: 1,
  repository: { id: 1, full_name: repo },
  head_repository: { id: 1, full_name: repo },
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
    id: 12,
    head_sha: commit,
    head_branch: 'main',
    repository_id: 1,
    head_repository_id: 1,
  },
};
test('provenance accepts only exact repository/source/main-push/completed-success CI', () => {
  assert.equal(trustedRun(run, repo, commit), true);
  for (const [key, value] of Object.entries({
    id: 0,
    repository: { id: 2, full_name: 'fork/project' },
    head_repository: { id: 2, full_name: 'fork/project' },
    head_sha: 'b'.repeat(40),
    head_branch: 'feature',
    event: 'pull_request',
    status: 'in_progress',
    conclusion: 'failure',
    path: '.github/workflows/other.yml',
  }))
    assert.equal(trustedRun({ ...run, [key]: value }, repo, commit), false, key);
});
test('artifact identity, expiry, size, digest and workflow provenance are mandatory', () => {
  assert.equal(trustedArtifact(artifact, run), true);
  for (const [key, value] of Object.entries({
    id: 0,
    name: 'pr-cache',
    expired: true,
    size_in_bytes: 0,
    digest: null,
    workflow_run: { ...artifact.workflow_run, head_sha: 'b'.repeat(40) },
  }))
    assert.equal(trustedArtifact({ ...artifact, [key]: value }, run), false, key);
  for (const key of Object.keys(artifact.workflow_run))
    assert.equal(
      trustedArtifact(
        { ...artifact, workflow_run: { ...artifact.workflow_run, [key]: null } },
        run,
      ),
      false,
      key,
    );
  assert.throws(() => verifyArchive(Buffer.from('corrupt'), artifact), /digest mismatch/);
  for (const entries of [
    ['../manifest.json', 'report.json'],
    ['manifest.json', 'report.json', 'extra'],
    ['manifest.json', 'manifest.json'],
    ['manifest.json'],
  ])
    assert.throws(() => verifyEntries(entries));
});
test('real zip transport validates digest and fixed JSON entries; failures remove stale provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-test-'));
  try {
    const report = '{"files":{}}';
    const manifest = JSON.stringify({
      sourceCommit: commit,
      completed: true,
      reportSha256: sha256(report),
    });
    await writeFile(join(root, 'manifest.json'), manifest);
    await writeFile(join(root, 'report.json'), report);
    execFileSync('zip', ['-q', 'baseline.zip', 'manifest.json', 'report.json'], { cwd: root });
    const bytes = await readFile(join(root, 'baseline.zip'));
    const realArtifact = {
      ...artifact,
      size_in_bytes: bytes.length,
      digest: 'sha256:' + sha256(bytes),
    };
    const api = (path) =>
      path.endsWith('/runs/12')
        ? JSON.stringify(run)
        : path.includes('/workflows/')
          ? JSON.stringify({ workflow_runs: [run] })
          : path.endsWith('/zip')
            ? bytes
            : JSON.stringify({ artifacts: [realArtifact] });
    const result = await restoreBaseline(root, repo, commit, api);
    assert.equal(result.restored, true);
    assert.equal(result.artifactId, artifact.id);
    assert.equal(
      await readFile(join(root, '.cache/mutation/validated/report.json'), 'utf8'),
      report,
    );
    for (const failApi of [
      () => {
        throw new Error('403 secret');
      },
      () => JSON.stringify({ workflow_runs: [] }),
      (path) => (path.endsWith('/zip') ? Buffer.from('corrupt') : api(path)),
    ]) {
      const failure = await restoreBaseline(root, repo, commit, failApi);
      assert.equal(failure.restored, false);
      assert.doesNotMatch(JSON.stringify(failure), /secret/);
      await assert.rejects(readFile(join(root, '.cache/mutation/provenance.json')), {
        code: 'ENOENT',
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
