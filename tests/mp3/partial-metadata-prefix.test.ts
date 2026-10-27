import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { Mp3ParseError } from '../../src/mp3/errors.js';
import { chunks } from '../helpers/mp3-fixtures.js';
import { metadataTag, metadataV1 } from '../helpers/metadata-fixtures.js';
import {
  prefixCases,
  singleton,
  singletonFixture,
  withAncillarySuffix,
} from '../helpers/partial-metadata-prefix-fixtures.js';

// These are not truncated MPEG files: a whole normally flushed LAME frame is
// preserved. Only proven unused ancillary bytes are replaced with tag-like data.
// For still-plausible prefixes the expected rejection is conservative project
// inference policy, not a claim that the independently decoded audio is invalid.
describe('available-byte evidence in short-frame metadata lookalikes', () => {
  it('proves all suffix substitutions are in unused ancillary bytes', () => {
    expect(singleton.length).toBe(417);
    expect(createHash('sha256').update(singleton).digest('hex')).toBe(singletonFixture.sha256);
    const sideBits = [...singleton.subarray(4, 21)]
      .map((byte) => byte.toString(2).padStart(8, '0'))
      .join('');
    // MPEG-1 mono: 9 reservoir bits, 5 private bits, 4 scfsi bits; then two
    // 59-bit granules starting with the 12-bit part2_3_length field, corroborated
    // independently against LAME encodeSideInfo2, not our parser implementation.
    for (const [start, end] of [
      [0, 9],
      [18, 30],
      [77, 89],
    ]) {
      expect(Number.parseInt(sideBits.slice(start, end), 2)).toBe(0);
    }
    for (const row of prefixCases) {
      const bytes = withAncillarySuffix(row.prefix);
      expect(bytes.length).toBe(singleton.length);
      expect(bytes.subarray(0, 21)).toEqual(singleton.subarray(0, 21));
    }
  });

  it('keeps genuine two-frame versus metadata-tail count conflicts conservative', async () => {
    // Concatenate two complete independently flushed zero-main-data frames.
    // A plausible final tag also permits a one-larger-frame interpretation,
    // so this is a count ambiguity, not a declaration of invalid decoded audio.
    const footer = metadataTag(4, { footer: true });
    for (const prefix of [
      metadataV1(),
      footer,
      footer.subarray(0, -1),
      metadataTag(3).subarray(0, 9),
    ]) {
      const bytes = Buffer.concat([singleton, withAncillarySuffix(prefix)]);
      for (const partition of [[1], [2, 3, 5, 11], [bytes.length]]) {
        await expect(countMp3Frames(chunks(bytes, partition))).rejects.toMatchObject({
          kind: 'unsupported-format',
          offset: 0,
        });
      }
    }
  });

  it('does not infer a metadata tail from bytes that already rule it out', async () => {
    const badFooter = Buffer.from(metadataTag(4, { footer: true }).subarray(0, -1));
    badFooter[badFooter.length - 1]! ^= 1;
    for (const prefix of [
      Buffer.from([73, 68, 51, 4, 0, 1]),
      badFooter,
      Buffer.concat([metadataV1(), Buffer.from([1])]),
    ]) {
      const bytes = Buffer.concat([singleton, withAncillarySuffix(prefix)]);
      for (const partition of [[1], [2, 3, 5, 11], [bytes.length]]) {
        expect(await countMp3Frames(chunks(bytes, partition))).toBe(2);
      }
    }
  });

  it.each(prefixCases)('$name', async (row) => {
    const bytes = withAncillarySuffix(row.prefix);
    for (const partition of [[1], [2, 3, 5, 11], [bytes.length]]) {
      const result = countMp3Frames(chunks(bytes, partition));
      if (row.impossibleUnderSupportedPolicy) await expect(result).resolves.toBe(1);
      else await expect(result).rejects.toBeInstanceOf(Mp3ParseError);
    }
  });
});

// Unlike candidate-boundary evidence, a known indexed-frame boundary remains
// strict: incomplete tags are errors even if available bytes already look bad.
// The indexed MPEG bytes here are structural test data, not encoded audio.
describe('strict truncation after an independently sized indexed frame', () => {
  const indexedBytes = Math.floor((144000 * 128) / 44100);
  const indexed = Buffer.alloc(indexedBytes);
  indexed.set([0xff, 0xfb, 0x90, 0xc0]); // MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono.

  it.each(prefixCases.filter((row) => row.available < 10))('$name', async (row) => {
    const bytes = Buffer.concat([indexed, row.prefix]);
    // Header failures are at the tag start. Footer failures follow its complete
    // ten-byte header + title record, independently known from fixture length.
    const offset = indexedBytes + (row.family === 'header' ? 0 : row.prefix.length - row.available);
    for (const partition of [[1], [2, 3, 5, 11], [bytes.length]]) {
      await expect(countMp3Frames(chunks(bytes, partition))).rejects.toMatchObject({
        kind: 'truncated-mp3',
        offset,
      });
    }
  });
});
