import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createStructuredMp3 } from '../fuzz/create-structured.mjs';

function seed(flags = 8) {
  const bytes = Buffer.alloc(160);
  bytes[1] = flags;
  return bytes;
}

test('free-format manifests cover the supported bitrate/sample-rate combinations', () => {
  // Independently tabulated unpadded spans at 44.1, 48 and 32 kHz.
  const spans = [
    [26, 24, 36],
    [104, 96, 144],
    [417, 384, 576],
    [447, 411, 616],
    [835, 768, 1152],
    [1044, 960, 1440],
    [1253, 1152, 1728],
    [1306, 1200, 1800],
    [1632, 1500, 2250],
    [2089, 1920, 2880],
  ];
  for (const [bitrate, rates] of spans.entries()) {
    for (const [rate, length] of rates.entries()) {
      const input = seed();
      input[4] = bitrate;
      input[5] = rate;
      const fixture = createStructuredMp3(input);
      assert.equal(fixture.expectedCount, 3);
      assert.deepEqual(fixture.frameLengths, [length, length, length]);
      assert.deepEqual(fixture.frameOffsets, [0, length, 2 * length]);
      assert.equal(fixture.bytes.length, 3 * length);
      for (const offset of fixture.frameOffsets) {
        assert.equal(fixture.bytes[offset + 2], rate << 2);
      }
    }
  }
});

test('small free-format spans retain a fixed base with per-frame padding and CRC', () => {
  const input = seed();
  input[0] = 3;
  input[5] = 1;
  for (let frame = 0; frame < 6; frame++) {
    input[11 + 5 * frame] = frame % 2;
    input[12 + 5 * frame] = frame % 2;
  }
  const fixture = createStructuredMp3(input);
  assert.deepEqual(fixture.frameOffsets, [0, 24, 49, 73, 98, 122]);
  assert.deepEqual(fixture.frameLengths, [24, 25, 24, 25, 24, 25]);
  assert.equal(fixture.bytes.length, 147);
  for (const [frame, offset] of fixture.frameOffsets.entries()) {
    assert.equal(fixture.bytes[offset + 1] & 1, 1 - (frame % 2));
    assert.equal(fixture.bytes[offset + 3] >>> 6, 3);
  }
});

test('frame offsets exclude surrounding tags and never trust declared VBR counts', () => {
  for (const kind of [0, 1, 2]) {
    const input = seed(31);
    input[0] = 1;
    input[3] = 3;
    input[4] = 5;
    input[5] = 2;
    input[6] = kind;
    input[8] = 2;
    const fixture = createStructuredMp3(input);
    assert.equal(fixture.bytes.subarray(0, 3).toString(), 'ID3');
    assert.equal(fixture.bytes.subarray(13, 16).toString(), '3DI');
    assert.deepEqual(fixture.frameOffsets, [23, 1463, 2903, 4343]);
    assert.deepEqual(fixture.frameLengths, [1440, 1440, 1440, 1440]);
    assert.equal(fixture.expectedCount, 4);
    assert.equal(fixture.metadataFrameCount, 1);
    assert.equal(fixture.expectedAudioFrameCount, 3);
    const initial = fixture.bytes.subarray(23, 1463);
    assert.equal(initial.subarray(36, 40).toString(), ['Xing', 'Info', 'VBRI'][kind]);
    assert.equal(initial.readUInt32BE(kind < 2 ? 44 : 50), 127);
    assert.equal(fixture.bytes.subarray(-128, -125).toString(), 'TAG');
  }
});

test('curated structured seeds exercise both smallest and largest supported free spans', async () => {
  for (const [name, count, base] of [
    ['free-format-minimum.bin', 3, 24],
    ['free-format-maximum.bin', 7, 2880],
  ]) {
    const input = await readFile(new URL(`../fuzz/seeds/structured/${name}`, import.meta.url));
    const fixture = createStructuredMp3(input);
    assert.equal(fixture.expectedCount, count);
    for (const [frame, offset] of fixture.frameOffsets.entries()) {
      const padding = (fixture.bytes[offset + 2] >>> 1) & 1;
      assert.equal(fixture.frameLengths[frame] - padding, base);
    }
  }
});

test('only first-frame metadata at a recognized position is an expected exclusion', async () => {
  for (const [name, physical, audio, frame, offset, signature] of [
    ['encoder-frame-xing.bin', 4, 3, 0, 36, 'Xing'],
    ['lone-encoder-frame.bin', 1, 0, 0, 36, 'VBRI'],
    ['crc-shifted-info.bin', 3, 2, 0, 38, 'Info'],
    ['shifted-info-without-crc.bin', 3, 3, 0, 38, 'Info'],
    ['later-frame-decoy.bin', 4, 4, 1, 36, 'Xing'],
  ]) {
    const input = await readFile(new URL(`../fuzz/seeds/structured/${name}`, import.meta.url));
    const fixture = createStructuredMp3(input);
    assert.equal(fixture.expectedCount, physical, name);
    assert.equal(fixture.expectedAudioFrameCount, audio, name);
    const start = fixture.frameOffsets[frame] + offset;
    assert.equal(fixture.bytes.subarray(start, start + 4).toString(), signature, name);
  }
});

test('short free-format and inserted metadata retain independent frame geometry', () => {
  for (const count of [1, 2]) {
    const input = seed(8 | 64 | 128 | 4);
    input[0] = count - 1;
    input[2] = 64;
    input[4] = 2; // 128 kbps at 44.1 kHz = 417 bytes, no padding.
    const fixture = createStructuredMp3(input);
    assert.equal(fixture.expectedCount, count);
    assert.deepEqual(fixture.frameLengths, Array(count).fill(417));
    assert.deepEqual(fixture.frameOffsets, count === 1 ? [0] : [0, 435]);
    if (count === 2) assert.equal(fixture.bytes.subarray(417, 420).toString(), 'ID3');
    const tail = fixture.frameOffsets.at(-1) + 417;
    assert.equal(fixture.bytes.subarray(tail, tail + 3).toString(), 'ID3');
    assert.equal(fixture.bytes.subarray(-138, -135).toString(), '3DI');
    assert.equal(fixture.bytes.subarray(-128, -125).toString(), 'TAG');
  }
});
