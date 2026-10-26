import assert from 'node:assert/strict';
import { githubReader } from './release-notes.mjs';
import { isMain } from './release-utils.mjs';

export async function verifyNotesArtifacts(env, read) {
  for (const [id, digest, prefix] of [
    [env.PLAN_ID, env.PLAN_DIGEST, 'input'],
    [env.NATIVE_ID, env.NATIVE_DIGEST, 'native'],
  ]) {
    assert.match(id, /^[1-9]\d*$/);
    assert.match(digest, /^[a-f0-9]{64}$/);
    const artifact = await read(`actions/artifacts/${id}`);
    assert.equal(String(artifact.id), id);
    assert.equal(
      artifact.name,
      `release-notes-${prefix}-${env.RELEASE_TAG}-${env.GITHUB_RUN_ATTEMPT}`,
    );
    assert.equal(artifact.digest, `sha256:${digest}`);
    assert.equal(artifact.expired, false);
    assert.equal(String(artifact.workflow_run.id), env.GITHUB_RUN_ID);
    assert.equal(String(artifact.workflow_run.repository_id), env.GITHUB_REPOSITORY_ID);
    assert.equal(String(artifact.workflow_run.head_repository_id), env.GITHUB_REPOSITORY_ID);
    assert.equal(artifact.workflow_run.head_sha, env.GITHUB_SHA);
  }
}

if (isMain(import.meta.url)) {
  await verifyNotesArtifacts(process.env, githubReader(process.env.GH_REPO));
}
