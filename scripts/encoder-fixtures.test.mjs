import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireEncoder, pcmWave, inspectEncoded } from './encoder-fixtures.mjs';

test('required encoder lane fails rather than silently skipping missing LAME', () => {
  assert.throws(() => requireEncoder('/definitely-absent-lame'), /LAME 3\.100 is required/);
});
test('deterministic PCM input has independently known duration and format', () => {
  const wave = pcmWave(32_000, 2);
  assert.equal(wave.length, 44 + 16_000 * 2 * 2);
  assert.equal(wave.readUInt32LE(24), 32_000);
  assert.equal(wave.readUInt16LE(22), 2);
  assert.deepEqual(wave, pcmWave(32_000, 2));
});
test('encoder provenance rejects missing or malformed metadata and truncated spans', () => {
  for (const data of [Buffer.alloc(100), Buffer.from([255, 251, 0, 0])]) {
    assert.throws(() => inspectEncoded(data, { rate: 44_100, channels: 1, bitrate: 400 }));
  }
});
