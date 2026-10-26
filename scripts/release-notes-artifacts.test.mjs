import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyNotesArtifacts } from './release-notes-artifacts.mjs';

const env = {
  PLAN_ID: '11',
  PLAN_DIGEST: 'a'.repeat(64),
  NATIVE_ID: '12',
  NATIVE_DIGEST: 'b'.repeat(64),
  RELEASE_TAG: 'v2.0.0',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_RUN_ID: '123',
  GITHUB_REPOSITORY_ID: '42',
  GITHUB_SHA: 'c'.repeat(40),
};
const artifacts = () =>
  Object.fromEntries(
    [
      ['11', 'input', env.PLAN_DIGEST],
      ['12', 'native', env.NATIVE_DIGEST],
    ].map(([id, prefix, digest]) => [
      id,
      {
        id: Number(id),
        name: `release-notes-${prefix}-v2.0.0-1`,
        expired: false,
        digest: `sha256:${digest}`,
        workflow_run: {
          id: 123,
          repository_id: 42,
          head_repository_id: 42,
          head_sha: env.GITHUB_SHA,
        },
      },
    ]),
  );

test('notes transport binds IDs, digests, repository, source, run and attempt before download', async () => {
  for (const change of [
    null,
    (a) => {
      a.id = 99;
    },
    (a) => {
      a.name = 'release-notes-input-v2.0.0-2';
    },
    (a) => {
      a.expired = true;
    },
    (a) => {
      a.digest = 'sha256:' + '0'.repeat(64);
    },
    (a) => {
      a.workflow_run.id = 124;
    },
    (a) => {
      a.workflow_run.repository_id = 99;
    },
    (a) => {
      a.workflow_run.head_repository_id = 99;
    },
    (a) => {
      a.workflow_run.head_sha = 'd'.repeat(40);
    },
  ]) {
    const data = artifacts();
    if (change) change(data['11']);
    const promise = verifyNotesArtifacts(env, async (path) => data[path.split('/').at(-1)]);
    if (change) await assert.rejects(promise);
    else await promise;
  }
  const workflow = await readFile(
    new URL('../.github/workflows/release-notes.yml', import.meta.url),
    'utf8',
  );
  const compose = workflow.split('\n  compose:\n')[1];
  assert.ok(
    compose.indexOf('node scripts/release-notes-artifacts.mjs') <
      compose.indexOf('actions/download-artifact'),
  );
  assert.equal(compose.match(/artifact-ids:/g).length, 2);
  assert.doesNotMatch(compose, /name: release-notes-(?:input|native)-/);
});
