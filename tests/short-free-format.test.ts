import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks } from './helpers/mp3-fixtures.js';
import { metadataTag, metadataV1 } from './helpers/metadata-fixtures.js';

interface Fixture {
  rate: number;
  channels: number;
  crc: boolean;
  kbps: number;
  pcmSamples: number;
  frames: number;
  offsets: number[];
  sha256: string;
  base64: string;
}
const manifest = JSON.parse(
  await readFile(new URL('./fixtures/short-free-format.json', import.meta.url), 'utf8'),
) as { encoder: string; fixtures: Fixture[] };
const count = (bytes: Uint8Array, sizes: number[] = [1, 3, 7, 128]) =>
  countMp3Frames(chunks(bytes, sizes));

// Committed fixtures are normal encoder output, not trimmed longer MP3 files.
describe('genuine normally flushed short free-format files', () => {
  it.each(manifest.fixtures)(
    '$rate Hz, $channels channel(s), CRC=$crc, $kbps kbps, $pcmSamples PCM samples',
    async (fixture) => {
      const bytes = Buffer.from(fixture.base64, 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      expect(fixture.frames).toBe(fixture.pcmSamples === 0 ? 1 : 2);
      // Separate oracle: encoder setting determines base span; padding is on wire.
      const base = Math.floor((144000 * fixture.kbps) / fixture.rate);
      let end = 0;
      for (const offset of fixture.offsets) {
        expect(offset).toBe(end);
        end += base + ((bytes[offset + 2]! >> 1) & 1);
      }
      expect(end).toBe(bytes.length);
      for (const sizes of [[1], [2, 3, 5, 11], [bytes.length]]) {
        expect(await count(bytes, sizes)).toBe(fixture.frames);
      }
      const tagged = Buffer.concat([
        metadataTag(4, { seek: bytes.length }),
        bytes,
        metadataTag(4, { footer: true }),
        metadataV1(1),
      ]);
      expect(await count(tagged)).toBe(fixture.frames);
    },
  );

  it('allows invalid or unsupported metadata envelopes in verified ancillary bytes', async () => {
    const fixture = manifest.fixtures.find(
      (item) =>
        item.rate === 44100 &&
        item.channels === 1 &&
        !item.crc &&
        item.kbps === 128 &&
        item.pcmSamples === 0,
    )!;
    const original = Buffer.from(fixture.base64, 'base64');
    // Independent side-info oracle: MPEG-1 mono has 9 reservoir bits, 5 private
    // bits, 4 scfsi bits, then two 59-bit granule records. The first 12 bits of
    // each granule give its complete scale-factor + Huffman bit length.
    // LAME's original encodeSideInfo2 corroborates these field widths/order.
    const side = [...original.subarray(4, 21)]
      .map((byte) => byte.toString(2).padStart(8, '0'))
      .join('');
    expect(Number.parseInt(side.slice(0, 9), 2)).toBe(0);
    expect(Number.parseInt(side.slice(18, 30), 2)).toBe(0);
    expect(Number.parseInt(side.slice(77, 89), 2)).toBe(0);
    expect(original.length).toBe(417);
    // No reservoir or main-data bits: these replacements affect ancillary
    // bytes only, not the normally flushed encoder frame's length or audio.
    const badFooter = metadataTag(4, { footer: true });
    badFooter[badFooter.length - 1] = 9;
    for (const decoy of [
      badFooter,
      [73, 68, 51, 5, 0, 0, 0, 0, 0, 0],
      [73, 68, 51, 4, 255, 0, 0, 0, 0, 0],
      [73, 68, 51, 4, 0, 1, 0, 0, 0, 0],
      [73, 68, 51, 4, 0, 0, 128, 0, 0, 0],
      [84, 65, 71],
    ]) {
      const bytes = Buffer.from(original);
      bytes.set(decoy, 80);
      for (const sizes of [[1], [2, 3, 5, 11], [bytes.length]]) {
        expect(await count(bytes, sizes)).toBe(1);
      }
    }
  });

  it.each([2, 3, 4] as const)(
    'crosses ID3v2.%i before free-format length acquisition, without retaining large bodies',
    async (version) => {
      const fixture = manifest.fixtures.find(
        (item) =>
          item.frames === 2 &&
          item.rate === 44100 &&
          item.channels === 1 &&
          !item.crc &&
          item.kbps === 128,
      )!;
      const bytes = Buffer.from(fixture.base64, 'base64');
      const split = fixture.offsets[1]!;
      for (const padding of [0, 20000]) {
        const tag = metadataTag(version, { padding });
        const tagged = Buffer.concat([bytes.subarray(0, split), tag, bytes.subarray(split)]);
        expect(await count(tagged, [1, 97])).toBe(2);
      }
    },
  );

  it('keeps metadata anchors stable on either side of the bounded probe edge', async () => {
    const fixture = manifest.fixtures.find(
      (item) =>
        item.frames === 2 &&
        item.rate === 44100 &&
        item.channels === 1 &&
        !item.crc &&
        item.kbps === 128,
    )!;
    const bytes = Buffer.from(fixture.base64, 'base64');
    const split = fixture.offsets[1]!;
    for (const delta of [-4, -3, -2, -1, 0, 1, 2, 3, 4]) {
      const padding = 8647 - split - metadataTag(3).length + delta;
      const tag = metadataTag(3, { padding });
      expect(
        await count(Buffer.concat([bytes.subarray(0, split), tag, bytes.subarray(split)])),
      ).toBe(2);
    }
  });

  it('streams a large footer-bearing appended tag after a genuine single frame', async () => {
    const fixture = manifest.fixtures.find((item) => item.frames === 1)!;
    const bytes = Buffer.from(fixture.base64, 'base64');
    // Large title record, not footer-forbidden padding: expand title data and both sizes.
    const tag = metadataTag(4, { footer: true });
    const body = Buffer.concat([tag.subarray(10, -10), Buffer.alloc(20000, 65)]);
    const size = body.length;
    const header = Buffer.from(tag.subarray(0, 10));
    header.set([size >>> 21, (size >>> 14) & 127, (size >>> 7) & 127, size & 127], 6);
    const recordSize = size - 10;
    body.set(
      [recordSize >>> 21, (recordSize >>> 14) & 127, (recordSize >>> 7) & 127, recordSize & 127],
      4,
    );
    const footer = Buffer.from(header);
    footer.write('3DI', 0, 'ascii');
    expect(await count(Buffer.concat([bytes, header, body, footer, metadataV1()]), [7])).toBe(1);
  });
});
