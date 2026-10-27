import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export function campaignProvenance(root, env = process.env, git = execFileSync) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  const sourceCommit = git('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, 'Missing checked-out source identity');
  assert.equal(
    sourceCommit,
    env.CACHE_CAMPAIGN_COMMIT,
    'Campaign checkout does not match requested source',
  );
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/, 'Missing repository identity');
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    assert.match(env[name] ?? '', /^[1-9]\d*$/, `Missing ${name}`);
  }
  return {
    repository: env.GITHUB_REPOSITORY,
    sourceCommit,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}
