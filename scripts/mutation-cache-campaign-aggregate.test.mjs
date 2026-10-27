import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { campaignNames, campaignScenarios } from './mutation-cache-campaigns.mjs';
import { campaignProvenance } from './mutation-cache-campaign-provenance.mjs';
import {
  campaignArtifactName,
  verifyCampaignArtifacts,
} from './verify-mutation-cache-campaign.mjs';

const identity = {
  repository: 'example/project',
  sourceCommit: 'a'.repeat(40),
  runId: '123',
  runAttempt: '2',
};
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: identity.repository,
  CACHE_CAMPAIGN_COMMIT: identity.sourceCommit,
  GITHUB_RUN_ID: identity.runId,
  GITHUB_RUN_ATTEMPT: identity.runAttempt,
};
const nativeGit = () => identity.sourceCommit + '\n';

function summary(campaign) {
  return {
    schemaVersion: 1,
    completed: true,
    campaigns: [campaign],
    provenance: identity,
    results: campaignScenarios[campaign].map(([name, status]) => ({
      name,
      status,
      elapsedMs: 1,
      ...(status === 0 ? { execution: { total: 2, executed: 1, reused: 1 } } : {}),
    })),
  };
}

async function evidence(use) {
  const root = await mkdtemp(join(tmpdir(), 'cache-campaign-aggregate-'));
  try {
    for (const campaign of campaignNames) {
      const path = join(root, campaignArtifactName(campaign, identity.runAttempt));
      await mkdir(path);
      await writeFile(join(path, 'completion.json'), JSON.stringify(summary(campaign)));
    }
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('aggregate validates all four source-bound summaries and exactly 70 final outcomes', async () => {
  await evidence(async (root) => assert.equal(await verifyCampaignArtifacts(root, identity), 70));
});

for (const [name, edit] of [
  ['missing matrix leg', async (root, path) => rm(path, { recursive: true })],
  [
    'unexpected duplicate leg',
    async (root) => mkdir(join(root, 'mutation-cache-verification-extra-2')),
  ],
  ['incomplete callback', async (root, path) => rm(join(path, 'completion.json'))],
  [
    'symlinked result',
    async (root, path) => {
      await rm(join(path, 'completion.json'));
      await symlink(
        join(root, campaignArtifactName('impact', identity.runAttempt), 'completion.json'),
        join(path, 'completion.json'),
      );
    },
  ],
  ['malformed result', async (root, path) => writeFile(join(path, 'completion.json'), '{')],
  [
    'different source',
    async (root, path) => {
      const result = summary('invalidation');
      result.provenance = { ...identity, sourceCommit: 'b'.repeat(40) };
      await writeFile(join(path, 'completion.json'), JSON.stringify(result));
    },
  ],
  [
    'cancelled outcome',
    async (root, path) => {
      const result = summary('invalidation');
      result.results[0].status = 'cancelled';
      await writeFile(join(path, 'completion.json'), JSON.stringify(result));
    },
  ],
])
  test(`${name} cannot pass the stable aggregate`, async () => {
    await evidence(async (root) => {
      await edit(root, join(root, campaignArtifactName('invalidation', identity.runAttempt)));
      await assert.rejects(verifyCampaignArtifacts(root, identity));
    });
  });

test('hosted provenance binds actual checkout and all invocation identities', () => {
  assert.deepEqual(campaignProvenance('.', env, nativeGit), identity);
  assert.equal(campaignProvenance('.', {}, nativeGit), null);
  for (const name of Object.keys(env).filter((key) => key !== 'GITHUB_ACTIONS')) {
    assert.throws(() => campaignProvenance('.', { ...env, [name]: '' }, nativeGit));
  }
  assert.throws(() => campaignProvenance('.', env, () => 'b'.repeat(40)));
});

test('unknown campaign flags fail before starting any native campaign', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/verify-mutation-cache.mjs', '--campaign=omitted-tests'],
    {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported campaign selection/);
});

test('workflow runs every fixed campaign and requires isolated current-attempt evidence', async () => {
  const workflow = parse(
    await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  const matrix = workflow.jobs['mutation-cache-scenarios'];
  assert.deepEqual(matrix.strategy, { 'fail-fast': false, matrix: { campaign: campaignNames } });
  assert.equal(matrix.needs, undefined);
  assert.equal(matrix.if, undefined);
  assert.equal(matrix['continue-on-error'], undefined);
  assert.ok(
    matrix.steps.some(
      (step) =>
        step.run === 'npm run test:mutation-cache:integration -- --campaign=${{ matrix.campaign }}',
    ),
  );
  const upload = matrix.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, 'always()');
  assert.equal(
    upload.with.name,
    'mutation-cache-verification-${{ matrix.campaign }}-${{ github.run_attempt }}',
  );
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with.overwrite, undefined);
  const aggregate = workflow.jobs['mutation-cache'];
  assert.equal(aggregate.name, 'Mutation cache regression (complete campaign)');
  assert.equal(aggregate.if, 'always()');
  assert.deepEqual(aggregate.needs, ['mutation-cache-scenarios']);
  const runtime = aggregate.steps.find((step) => step.uses === './.github/actions/setup-project');
  assert.deepEqual(runtime.with, { install: 'false' });
  const download = aggregate.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  assert.equal(download.with.pattern, 'mutation-cache-verification-*-${{ github.run_attempt }}');
  assert.equal(download.with['merge-multiple'], false);
  assert.equal(download.with['digest-mismatch'], 'error');
  assert.equal(download.with['run-id'], undefined);
  assert.equal(download.with['github-token'], undefined);
  assert.ok(aggregate.steps.some((step) => step.run === 'test "$RESULT" = success'));
  assert.ok(
    aggregate.steps.some(
      (step) =>
        step.run ===
        'node scripts/verify-mutation-cache-campaign.mjs reports/mutation-cache-campaigns',
    ),
  );
});
