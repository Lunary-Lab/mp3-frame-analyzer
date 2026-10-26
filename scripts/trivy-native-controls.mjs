import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCKING_SEVERITIES, lockInventory, trivyFindings } from './trivy-policy.mjs';

// Synthetic lock metadata only: no vulnerable package code is fetched or executed.
// This proves the actual pinned scanner + downloaded DB detect a known vulnerability,
// and that our wrapper refuses the actual scanner's missing-DB failure.
export async function nativeTrivyControls(binary, directory, scanLock) {
  const fixture = {
    name: 'synthetic-control',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'synthetic-control', version: '1.0.0', dependencies: { lodash: '4.17.20' } },
      'node_modules/lodash': { version: '4.17.20' },
    },
  };
  const bytes = JSON.stringify(fixture);
  await writeFile(join(directory, 'package-lock.json'), bytes, { mode: 0o600 });
  const findings = trivyFindings(scanLock(binary, directory), lockInventory(fixture), 'synthetic');
  assert.ok(
    findings.some((finding) => BLOCKING_SEVERITIES.includes(finding.severity)),
    'The native vulnerable lock control did not produce a blocking finding',
  );
  const missing = await mkdtemp(join(tmpdir(), 'trivy-missing-db-'));
  try {
    await writeFile(join(missing, 'package-lock.json'), bytes, { mode: 0o600 });
    assert.throws(() => scanLock(binary, missing), 'A missing native database was accepted');
  } finally {
    await rm(missing, { recursive: true, force: true });
  }
}
