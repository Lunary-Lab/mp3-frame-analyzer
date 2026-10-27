import assert from 'node:assert/strict';

// Every existing native scenario runs exactly once. Expected rejection is a
// successful regression result, but only after its callback assertions finish.
export const campaignScenarios = {
  invalidation: [
    ['cold', 0],
    ['warm', 0],
    ['forced-full', 0],
    ['docs-only-reuses', 0],
    ['changed-test-new-survivor', 1],
    ['added-test', 0],
    ['removed-test', 1],
    ['changed-imported-helper-new-survivor', 1],
    ['changed-mutated-source', 0],
    ['stale-equivalence-context', 1],
    ['changed-fixture', 0],
    ['changed-snapshot', 0],
    ['changed-generator', 0],
    ['changed-lockfile', 0],
    ['changed-test-selection', 0],
    ['changed-property-seed', 0],
    ['changed-timezone', 0],
    ['wrong-version', 0],
    ['incomplete', 0],
    ['corrupt', 0],
    ['partial-working-report-ignored', 0],
    ['untrusted-pr-context', 0],
    ['markdown-fixture-cold', 0],
    ['markdown-fixture-new-survivor', 1],
  ],
  impact: [
    ['impact-cold', 0],
    ['impact-identical-warm', 0],
    ['impact-changed-test-partial', 0],
    ['impact-changed-test-full', 0],
    ['impact-changed-source-partial', 0],
    ['impact-changed-test-new-survivor', 1],
    ['impact-renamed-test-full', 0],
    ['impact-renamed-module-full', 0],
    ['impact-literal-dynamic-import', 0],
    ['impact-unresolved-dynamic-import-full', 0],
    ['impact-changed-caller-new-callee-survivor', 1],
    ['impact-changed-caller-full-confirmation', 1],
    ['impact-reexport-cycle-cold', 0],
    ['impact-reexport-cycle-source-change', 0],
    ['impact-deleted-module-and-test-full', 0],
    ['impact-isolated-file-globals-and-environment', 0],
  ],
  compatibility: [
    ['bounded-cold', 0],
    ['bounded-docs-and-nonparser-additions', 0],
    ['bounded-docs-and-nonparser-additions-full', 0],
    ['bounded-helper-new-survivor', 1],
    ['bounded-helper-new-survivor-full', 1],
    ['bounded-reader-introduced', 0],
    ['bounded-resource-new-survivor', 1],
    ['bounded-resource-new-survivor-full', 1],
    ['bounded-midrun-document-change', 1],
    ['bounded-config-reader-cold', 0],
    ['bounded-config-resource-new-survivor', 1],
    ['bounded-setup-reader-cold', 0],
    ['bounded-setup-resource-new-survivor', 1],
    ['bounded-plugin-reader-cold', 0],
    ['bounded-plugin-resource-new-survivor', 1],
    ['bounded-computed-opaque-cold', 0],
    ['bounded-computed-opaque-new-survivor', 1],
    ['bounded-computed-opaque-new-survivor-full', 1],
    ['bounded-quoted-opaque-cold', 0],
    ['bounded-quoted-opaque-new-survivor', 1],
    ['bounded-quoted-opaque-new-survivor-full', 1],
    ['bounded-context-opaque-cold', 0],
    ['bounded-context-opaque-new-survivor', 1],
    ['bounded-context-opaque-new-survivor-full', 1],
  ],
  documents: [
    ['bounded-instruction-cold', 0],
    ['bounded-instruction-prose-reuse', 0],
    ['bounded-instruction-prose-reuse-full', 0],
    ['bounded-instruction-reader-cold', 0],
    ['bounded-instruction-reader-new-survivor', 1],
    ['bounded-instruction-reader-new-survivor-full', 1],
  ],
};

export const campaignNames = Object.keys(campaignScenarios);

export function parseCampaignArguments(args) {
  let evidence;
  let campaigns;
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      assert.equal(evidence, undefined, 'Only one evidence directory is supported');
      evidence = arg;
      continue;
    }
    assert.equal(campaigns, undefined, 'Only one campaign selection is supported');
    if (arg === '--documents-only') campaigns = ['documents'];
    else if (arg === '--impact-only') campaigns = ['impact', 'compatibility', 'documents'];
    else {
      const name = arg.startsWith('--campaign=') ? arg.slice('--campaign='.length) : '';
      assert.ok(campaignNames.includes(name), 'Unsupported campaign selection');
      campaigns = [name];
    }
  }
  return {
    evidence: evidence ?? 'reports/mutation-cache-validation',
    campaigns: campaigns ?? campaignNames,
  };
}

function validateResult(result, status) {
  assert.equal(result.status, status, `Unexpected scenario outcome: ${result.name}`);
  assert.ok(
    Number.isSafeInteger(result.elapsedMs) && result.elapsedMs >= 0,
    'Missing scenario timing',
  );
  if (status !== 0) return;
  const execution = result.execution;
  assert.ok(
    execution && Number.isSafeInteger(execution.total) && execution.total > 0,
    'Missing mutant inventory',
  );
  for (const key of ['executed', 'reused']) {
    assert.ok(
      Number.isSafeInteger(execution[key]) && execution[key] >= 0,
      'Missing execution accounting',
    );
  }
  assert.equal(
    execution.executed + execution.reused,
    execution.total,
    'Incomplete execution accounting',
  );
}

export function validateCampaignSummary(summary, groups, provenance) {
  assert.equal(summary?.schemaVersion, 1, 'Unsupported campaign summary');
  assert.equal(summary.completed, true, 'Incomplete campaign');
  assert.deepEqual(summary.provenance, provenance, 'Campaign provenance mismatch');
  assert.deepEqual(summary.campaigns, groups, 'Incorrect campaign inventory');
  assert.ok(
    groups.every((group) => campaignNames.includes(group)),
    'Unknown campaign',
  );
  assert.equal(new Set(groups).size, groups.length, 'Duplicate campaigns');
  assert.ok(Array.isArray(summary.results), 'Missing scenario results');
  const expected = new Map(groups.flatMap((group) => campaignScenarios[group]));
  const names = summary.results.map((result) => result.name);
  assert.deepEqual(
    [...names].sort(),
    [...expected.keys()].sort(),
    'Incomplete or duplicate scenario inventory',
  );
  for (const result of summary.results) validateResult(result, expected.get(result.name));
  return summary.results.length;
}
