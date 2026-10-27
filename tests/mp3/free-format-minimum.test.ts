import { array, assert, asyncProperty, boolean, integer } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { chunks } from '../helpers/mp3-fixtures.js';
import { metadataTag, metadataV1 } from '../helpers/metadata-fixtures.js';
import { minimumFreeFrame } from '../helpers/minimum-free-format-fixtures.js';

const partitions = [[1], [2, 3, 5], [65_536]];
const count = (bytes: Uint8Array, sizes: readonly number[] = [1]) =>
  countMp3Frames(chunks(bytes, sizes));

describe('mandatory-prefix-sized free-format streams', () => {
  it('independently establishes complete silent mono frames, including a protected control', () => {
    const plain = minimumFreeFrame(21);
    expect([...plain.subarray(0, 4)]).toEqual([0xff, 0xfb, 0x04, 0xc0]);
    expect(plain.length).toBe((144 * 7_000) / 48_000);
    // §2.4.1.7: 9 reservoir + 5 private + 4 scfsi + two 59-bit granules.
    // All fields are zero: slen1/slen2=0, no scale-factor or Huffman bits,
    // and all 576 spectral lines in each granule are zero (§§2.4.3.4.5/.6).
    const sideBits = [...plain.subarray(4)]
      .map((byte) => byte.toString(2).padStart(8, '0'))
      .join('');
    expect(sideBits.length).toBe(9 + 5 + 4 + 2 * 59);
    expect(sideBits).toBe('0'.repeat(136));
    const protectedFrame = minimumFreeFrame(23, { crc: true });
    expect(protectedFrame.subarray(0, 6).toString('hex')).toBe('fffa04c0fae5');
    expect(protectedFrame.subarray(6)).toEqual(plain.subarray(4));
    // Independently checked with the standard's 16-cell shift register;
    // FAE5 protects the final 16 header bits and the 136 side-info bits.
  });

  it.each(
    [21, 22, 23, 24].flatMap((base) =>
      (base >= 23 ? [false, true] : [false]).flatMap((crc) =>
        [1, 2, 3, 4, 6, 8, 17, 500].map((frames) => ({ base, crc, frames })),
      ),
    ),
  )(
    'counts $frames complete $base-byte frames, CRC=$crc, without harmonic aliasing',
    async ({ base, crc, frames }) => {
      for (const padded of [false, true]) {
        const blocks = Array.from({ length: frames }, (_, index) =>
          minimumFreeFrame(base, { crc, padding: padded ? index % 2 : 0 }),
        );
        const bytes = Buffer.concat(blocks);
        for (const sizes of partitions) {
          expect(await count(bytes, sizes)).toBe(frames);
          expect(await countMp3Frames(chunks(bytes, sizes), { includeVbrHeaderFrame: false })).toBe(
            frames,
          );
        }
      }
    },
  );

  it('applies mandatory space to actual padded spans, not an invented minimum base', async () => {
    // A finite all-padded base20 chain is structural-policy coverage, not a
    // claim of a fully conformant long-term nominal-bitrate/padding schedule.
    for (const [base, crc] of [
      [20, false],
      [22, true],
    ] as const) {
      for (const frames of [1, 2, 3, 6, 8]) {
        const bytes = Buffer.concat(
          Array.from({ length: frames }, () => minimumFreeFrame(base, { padding: 1, crc })),
        );
        for (const sizes of partitions) expect(await count(bytes, sizes)).toBe(frames);
      }
    }
  });

  it.each([0, 1, 2, 3])(
    'checks every complete prefix for channel mode %i and changing protection',
    async (mode) => {
      for (const crc of [false, true]) {
        const base = (mode === 3 ? 21 : 36) + (crc ? 2 : 0);
        const bytes = Buffer.concat(
          Array.from({ length: 7 }, (_, index) =>
            minimumFreeFrame(base, { mode, crc: index % 2 === 0 && crc, padding: index % 2 }),
          ),
        );
        for (const sizes of partitions) expect(await count(bytes, sizes)).toBe(7);
      }
    },
  );

  it('retains small-span counts across compatible channel transitions and metadata boundaries', async () => {
    const blocks = Array.from({ length: 8 }, (_, index) =>
      minimumFreeFrame(38, { mode: index % 4, crc: index % 2 === 0 }),
    );
    const bytes = Buffer.concat([
      metadataTag(3),
      ...blocks.slice(0, 2),
      metadataTag(3),
      ...blocks.slice(2),
      metadataTag(4, { footer: true }),
      metadataV1(),
    ]);
    for (const sizes of partitions) expect(await count(bytes, sizes)).toBe(8);
    for (const base of [21, 22, 23, 24]) {
      const small = Buffer.concat([
        minimumFreeFrame(base),
        metadataTag(3),
        minimumFreeFrame(base),
        metadataTag(4, { footer: true }),
        metadataV1(),
      ]);
      for (const sizes of partitions) expect(await count(small, sizes)).toBe(2);
    }
  });

  it.each([
    { base: 21, mode: 3, crc: true, padding: 0 },
    { base: 22, mode: 3, crc: true, padding: 0 },
    { base: 21, mode: 0, crc: false, padding: 0 },
    { base: 22, mode: 1, crc: false, padding: 0 },
    { base: 23, mode: 2, crc: true, padding: 0 },
  ])(
    'rejects an established insufficient prefix at its exact boundary: $base/$mode/$crc',
    async ({ base, mode, crc, padding }) => {
      const intro = Array.from({ length: 5 }, () => minimumFreeFrame(base));
      const bytes = Buffer.concat([...intro, minimumFreeFrame(base, { mode, crc, padding })]);
      for (const sizes of partitions) {
        await expect(count(bytes, sizes)).rejects.toMatchObject({
          kind: 'invalid-mp3',
          offset: 5 * base,
          message: 'Free-format frame is smaller than its header and side information',
        });
      }
    },
  );

  it('rechecks mono CRC and no-CRC space when padding disappears after acquisition', async () => {
    for (const [base, crc] of [
      [20, false],
      [22, true],
    ] as const) {
      const frames = [
        ...Array.from({ length: 5 }, () => minimumFreeFrame(base, { padding: 1, crc })),
        minimumFreeFrame(base, { crc }),
      ];
      for (const sizes of partitions)
        await expect(count(Buffer.concat(frames), sizes)).rejects.toMatchObject({
          kind: 'invalid-mp3',
          offset: 5 * (base + 1),
        });
    }
  });

  it.each([21, 22])(
    'rejects a $0-byte protected mono chain at the first incomplete prefix',
    async (base) => {
      const bytes = Buffer.concat(
        Array.from({ length: 8 }, () => minimumFreeFrame(base, { crc: true })),
      );
      for (const sizes of partitions)
        await expect(count(bytes, sizes)).rejects.toMatchObject({ kind: 'invalid-mp3', offset: 0 });
    },
  );

  it('preserves unsupported-format and known truncation classifications at small boundaries', async () => {
    const intro = Array.from({ length: 5 }, () => minimumFreeFrame(21));
    const unsupported = minimumFreeFrame(21);
    unsupported[1] = 0xf3; // MPEG-2 Layer III, not this assessment's format.
    for (const sizes of partitions) {
      await expect(count(Buffer.concat([...intro, unsupported]), sizes)).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: 105,
      });
      await expect(
        count(Buffer.concat([...intro, minimumFreeFrame(21).subarray(0, 20)]), sizes),
      ).rejects.toMatchObject({ kind: 'truncated-mp3', offset: 125 });
    }
  });

  it('preserves constructed counts under padding, metadata insertion and chunk partitions', async () => {
    await assert(
      asyncProperty(
        integer({ min: 21, max: 24 }),
        array(boolean(), { minLength: 1, maxLength: 24 }),
        boolean(),
        integer({ min: 0, max: 2 }),
        array(integer({ min: 1, max: 97 }), { minLength: 1, maxLength: 8 }),
        async (base, padding, crc, rate, sizes) => {
          const blocks = padding.map((pad) =>
            minimumFreeFrame(base, { padding: Number(pad), crc: crc && base >= 23, rate }),
          );
          const plain = Buffer.concat(blocks);
          const tagged = Buffer.concat(
            blocks.flatMap((frame) => [frame, metadataTag(4, { footer: true })]),
          );
          expect(await count(plain, sizes)).toBe(blocks.length);
          expect(await count(tagged, sizes)).toBe(blocks.length);
        },
      ),
      { seed: 0x21f4a7, numRuns: 128 },
    );
  });
});
