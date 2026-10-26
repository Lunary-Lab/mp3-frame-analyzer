import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const baselinePath = 'governance/snapshots/baseline.json';
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const docs = readFileSync('docs/governance.md', 'utf8');
const comparison = docs
  .split('**Compare with the snapshot.**')[1]
  .match(/```bash\n([\s\S]*?)```/)[1];

function compareSnapshot(snapshot, override) {
  const directory = mkdtempSync(join(tmpdir(), 'governance-baseline-'));
  try {
    mkdirSync(join(directory, 'governance/snapshots'), { recursive: true });
    writeFileSync(join(directory, baselinePath), JSON.stringify(baseline));
    const fixture = join(directory, 'current.json');
    writeFileSync(fixture, JSON.stringify(snapshot));
    // Exercise the documented comparison, not a live settings collection.
    writeFileSync(join(directory, 'governance/snapshot.sh'), 'cat "$SNAPSHOT_FIXTURE"\n', {
      mode: 0o755,
    });
    const env = { PATH: process.env.PATH, SNAPSHOT_FIXTURE: fixture };
    if (override) {
      env.SNAPSHOT_BASELINE = join(directory, 'override.json');
      writeFileSync(env.SNAPSHOT_BASELINE, JSON.stringify(override));
    }
    const result = spawnSync(
      'bash',
      ['-c', comparison.replaceAll('/tmp/settings.json', join(directory, 'settings.json'))],
      {
        cwd: directory,
        encoding: 'utf8',
        env,
      },
    );
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('documented comparison defaults to the tracked public baseline', () => {
  const current = structuredClone(baseline);
  current.captured_at = '2030-01-01T00:00:00Z';
  delete current.settings.secret_scanning_alerts;
  const result = compareSnapshot(current);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('documented comparison accepts an explicit reviewed baseline override', () => {
  const override = { repository: 'synthetic/repository', settings: { repository: { value: {} } } };
  const result = compareSnapshot(override, override);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('documented comparison reports actual settings drift', () => {
  const current = structuredClone(baseline);
  current.settings.repository.value.has_wiki = !current.settings.repository.value.has_wiki;
  const result = compareSnapshot(current);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /has_wiki/);
});

test('governance documentation describes validation as a required aggregate gate', () => {
  assert.ok(
    docs.includes(
      'governance validation is required through the fail-closed `All checks` aggregate',
    ),
  );
  assert.doesNotMatch(docs, /warns rather than blocks/);
});
