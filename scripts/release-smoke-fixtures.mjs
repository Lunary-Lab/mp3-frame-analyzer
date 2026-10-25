import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const fixtureRoot = new URL('../tests/fixtures/', import.meta.url);

export function decodeFixtureManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.encoder, 'LAME 3.100');
  assert.ok(Array.isArray(manifest.records) && manifest.records.length > 0);
  return manifest.records.map((record) => {
    const bytes = Buffer.from(record.base64, 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024, 'Fixture size must stay bounded');
    assert.equal(bytes.length, record.bytes, 'Fixture byte length changed');
    assert.equal(bytes.toString('base64'), record.base64, 'Fixture base64 must be canonical');
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      record.sha256,
      'Fixture digest changed',
    );
    assert.ok(
      Number.isSafeInteger(record.audioFrames) &&
        record.audioFrames > 0 &&
        record.audioFrames < 100,
    );
    assert.equal(
      record.physicalFrames,
      record.audioFrames + 1,
      'Independent fixture counts disagree',
    );
    return {
      name: `free-format-${record.name}`,
      bytes,
      audioFrames: record.audioFrames,
      physicalFrames: record.physicalFrames,
    };
  });
}

export async function loadSmokeFixtures() {
  const fixtures = [];
  // Reviewed FFmpeg/libmp3lame fixtures; counts documented independently in docs/testing.md.
  for (const [name, audioFrames, physicalFrames] of [
    ['cbr', 32, 33],
    ['vbr', 32, 33],
    ['no-xing', 51, 51],
  ]) {
    const bytes = await readFile(new URL(`${name}.mp3`, fixtureRoot));
    fixtures.push({ name, bytes, audioFrames, physicalFrames });
  }
  const manifest = JSON.parse(
    await readFile(new URL('lame-free-format.json', fixtureRoot), 'utf8'),
  );
  assert.equal(manifest.records.length, 5, 'All reviewed genuine encoder configurations must run');
  return [...fixtures, ...decodeFixtureManifest(manifest)];
}
