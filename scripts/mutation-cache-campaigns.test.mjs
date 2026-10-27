import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  campaignNames,
  campaignScenarios,
  parseCampaignArguments,
  validateCampaignSummary,
} from './mutation-cache-campaigns.mjs';

const provenance = {
  repository: 'example/project',
  sourceCommit: 'a'.repeat(40),
  runId: '123',
  runAttempt: '2',
};
function summary(groups = campaignNames) {
  return {
    schemaVersion: 1,
    completed: true,
    campaigns: [...groups],
    provenance,
    results: groups.flatMap((group) =>
      campaignScenarios[group].map(([name, status]) => ({
        name,
        status,
        elapsedMs: 1,
        ...(status === 0 ? { execution: { total: 2, executed: 1, reused: 1 } } : {}),
      })),
    ),
  };
}

test('all 70 unchanged scenarios belong to exactly one independently runnable campaign', () => {
  assert.deepEqual(campaignNames, ['invalidation', 'impact', 'compatibility', 'documents']);
  assert.deepEqual(
    campaignNames.map((group) => campaignScenarios[group].length),
    [24, 16, 24, 6],
  );
  const names = campaignNames.flatMap((group) => campaignScenarios[group].map(([name]) => name));
  assert.equal(new Set(names).size, 70);
  assert.doesNotThrow(() => validateCampaignSummary(summary(), campaignNames, provenance));
  for (const group of campaignNames)
    assert.doesNotThrow(() => validateCampaignSummary(summary([group]), [group], provenance));
});

test('the default remains complete while explicit campaign and legacy selections are bounded', () => {
  assert.deepEqual(parseCampaignArguments([]), {
    evidence: 'reports/mutation-cache-validation',
    campaigns: campaignNames,
  });
  assert.deepEqual(parseCampaignArguments(['evidence', '--campaign=impact']), {
    evidence: 'evidence',
    campaigns: ['impact'],
  });
  assert.deepEqual(parseCampaignArguments(['--campaign=documents', 'evidence']), {
    evidence: 'evidence',
    campaigns: ['documents'],
  });
  assert.deepEqual(parseCampaignArguments(['--documents-only']).campaigns, ['documents']);
  assert.deepEqual(parseCampaignArguments(['--impact-only']).campaigns, [
    'impact',
    'compatibility',
    'documents',
  ]);
});

for (const args of [
  ['--campaign=unknown'],
  ['--campaign='],
  ['--impact-only', '--documents-only'],
  ['--campaign=impact', '--campaign=impact'],
  ['one', 'two'],
  ['--unknown'],
])
  test(`unsupported or ambiguous selections fail closed: ${args.join(' ')}`, () => {
    assert.throws(() => parseCampaignArguments(args));
  });

for (const [name, edit] of [
  ['missing result', (s) => s.results.pop()],
  ['duplicated result', (s) => s.results.push(s.results[0])],
  ['unexpected result', (s) => (s.results[0].name = 'unexpected')],
  ['incorrect outcome', (s) => (s.results[0].status = 1)],
  ['skipped outcome', (s) => (s.results[0].status = 'skipped')],
  ['missing fresh/reused accounting', (s) => delete s.results[0].execution],
  ['incomplete mutant accounting', (s) => (s.results[0].execution.total = 3)],
  ['cancelled campaign', (s) => (s.completed = false)],
  ['missing campaign', (s) => s.campaigns.pop()],
  ['duplicate campaign', (s) => s.campaigns.push(s.campaigns[0])],
  ['wrong source', (s) => (s.provenance = { ...provenance, sourceCommit: 'b'.repeat(40) })],
  ['wrong attempt', (s) => (s.provenance = { ...provenance, runAttempt: '1' })],
  ['wrong run', (s) => (s.provenance = { ...provenance, runId: '124' })],
  ['wrong repository', (s) => (s.provenance = { ...provenance, repository: 'other/project' })],
])
  test(`${name} cannot satisfy complete campaign evidence`, () => {
    const changed = summary();
    edit(changed);
    assert.throws(() => validateCampaignSummary(changed, campaignNames, provenance));
  });
