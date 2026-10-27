import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { campaignNames, validateCampaignSummary } from './mutation-cache-campaigns.mjs';
import { campaignProvenance } from './mutation-cache-campaign-provenance.mjs';

export const campaignArtifactName = (campaign, attempt) =>
  `mutation-cache-verification-${campaign}-${attempt}`;

export async function verifyCampaignArtifacts(root, provenance) {
  assert.ok(provenance, 'Hosted campaign provenance is required');
  const expected = campaignNames.map((name) => campaignArtifactName(name, provenance.runAttempt));
  const entries = await readdir(root);
  assert.deepEqual(
    entries.sort(),
    [...expected].sort(),
    'Missing or unexpected campaign artifacts',
  );
  let total = 0;
  for (const campaign of campaignNames) {
    const directory = join(root, campaignArtifactName(campaign, provenance.runAttempt));
    assert.ok((await lstat(directory)).isDirectory(), 'Campaign artifact must be a directory');
    const path = join(directory, 'completion.json');
    const stat = await lstat(path);
    assert.ok(stat.isFile() && stat.size <= 1024 * 1024, 'Invalid campaign completion file');
    const summary = JSON.parse(await readFile(path, 'utf8'));
    total += validateCampaignSummary(summary, [campaign], provenance);
  }
  return total;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.env.CACHE_CAMPAIGN_RESULT,
    'success',
    'Not every native campaign job succeeded',
  );
  assert.equal(process.argv.length, 3, 'Expected only the campaign artifact directory');
  const provenance = campaignProvenance(process.cwd());
  const total = await verifyCampaignArtifacts(resolve(process.argv[2]), provenance);
  console.log(
    `Verified all ${campaignNames.length} native campaigns: ${total} scenarios, one source/run/attempt.`,
  );
}
