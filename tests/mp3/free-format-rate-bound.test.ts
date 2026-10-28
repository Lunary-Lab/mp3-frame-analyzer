import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { chunks } from '../helpers/mp3-fixtures.js';

// Independent byte-spacing oracle. Zero side information declares no reservoir
// or audio bits, so bytes after each mandatory prefix are ancillary data.
function freeFrames(
  base: number,
  count: number,
  rateIndex = 1,
  mode = 3,
  crc = false,
  pads = [0],
): Buffer {
  return Buffer.concat(
    Array.from({ length: count }, (_, index) => {
      const padding = pads[index % pads.length]!;
      const bytes = Buffer.alloc(base + padding);
      bytes.set([0xff, crc ? 0xfa : 0xfb, (rateIndex << 2) | (padding << 1), mode << 6]);
      return bytes;
    }),
  );
}

function writeBits(bytes: Buffer, start: number, width: number, value: number): void {
  for (let bit = 0; bit < width; bit++) {
    const position = start + bit;
    bytes[position >>> 3]! |= ((value >>> (width - bit - 1)) & 1) << (7 - (position & 7));
  }
}

describe('free-format bitrate candidate eligibility', () => {
  it.each([1, 7, 4096, 7200])(
    'does not let an extension-only ancillary layout veto 300 kb/s frames (chunks %i)',
    async (chunkSize) => {
      const original = freeFrames(900, 8);
      const altered = Buffer.from(original);
      // Three 1,440-byte free frames at 48 kHz would require 480 kb/s.
      for (const offset of [1440, 2880]) altered.set([0xff, 0xfb, 4, 0xc0], offset);
      // Its changed-rate indexed suffix closes EOF, but cannot make that prefix legal.
      for (let offset = 4320; offset < altered.length; offset += 576)
        altered.set([0xff, 0xfb, 0x98, 0xc0], offset);
      for (let offset = 0; offset < altered.length; offset += 900)
        expect(altered.subarray(offset, offset + 21)).toEqual(
          original.subarray(offset, offset + 21),
        );
      await expect(countMp3Frames(chunks(original, [chunkSize]))).resolves.toBe(8);
      await expect(countMp3Frames(chunks(altered, [chunkSize]))).resolves.toBe(8);
    },
  );

  it.each([1, 2, 3, 8])('rejects %i free-format frames requiring 400 kb/s', async (count) => {
    await expect(countMp3Frames(chunks(freeFrames(1200, count), [7]))).rejects.toMatchObject({
      kind: 'unsupported-format',
      message:
        'Cannot infer a unique free-format MPEG frame size within the supported 320 kb/s bitrate envelope',
    });
  });

  it('rejects an extension-only changed-rate suffix after a legal prefix', async () => {
    const bytes = Buffer.concat([freeFrames(900, 3, 2), freeFrames(1200, 3, 1)]);
    for (const chunkSize of [1, 7, 4096])
      await expect(countMp3Frames(chunks(bytes, [chunkSize]))).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: 2700,
      });
  });

  it.each([384, 400, 500, 640, 882, 960])(
    'rejects the former extension rate %i kb/s at every sample rate',
    async (bitrate) => {
      for (const [rateIndex, rate] of [44100, 48000, 32000].entries()) {
        const bytes = freeFrames(Math.floor((144000 * bitrate) / rate), 4, rateIndex);
        await expect(countMp3Frames(chunks(bytes, [7, 4096]))).rejects.toMatchObject({
          kind: 'unsupported-format',
        });
      }
    },
  );

  it.each([1044, 960, 1440])(
    'retains a changed-rate successor needing all %i base bytes plus padding',
    async (maximum) => {
      const rateIndex = [1044, 960, 1440].indexOf(maximum);
      for (const crc of [false, true])
        for (const padding of [0, 1]) {
          for (const extra of [0, 1]) {
            const suffix = freeFrames(maximum, 1, rateIndex, 0, crc, [padding]);
            const prefix = crc ? 38 : 36;
            let remaining = (suffix.length - prefix + extra) * 8;
            // Four independent stereo part2_3_length records; this tests necessary
            // capacity, not the decoding of their zero-filled main data.
            for (let record = 0; record < 4; record++) {
              const bits = Math.min(4095, remaining);
              writeBits(suffix, (crc ? 6 : 4) * 8 + 20 + record * 59, 12, bits);
              remaining -= bits;
            }
            expect(remaining).toBe(0);
            const bytes = Buffer.concat([freeFrames(100, 2, (rateIndex + 1) % 3), suffix]);
            const result = countMp3Frames(chunks(bytes, [1, 7, 4096]));
            if (extra === 0) await expect(result).resolves.toBe(3);
            else await expect(result).rejects.toMatchObject({ kind: 'unsupported-format' });
          }
        }
    },
  );

  it.each([
    { rateIndex: 0, maximum: 1044 },
    { rateIndex: 1, maximum: 960 },
    { rateIndex: 2, maximum: 1440 },
  ])(
    'uses the unpadded boundary for every prefix at sample rate $rateIndex',
    async ({ rateIndex, maximum }) => {
      // The endpoint is the documented inclusive project interpretation. At
      // 44.1 kHz one inferred span represents a rate interval, not an exact rate.
      for (const mode of [0, 1, 2, 3])
        for (const crc of [false, true]) {
          for (const pads of [[0], [1], [1, 0, 1]])
            for (const count of [1, 2, 4]) {
              for (const base of [maximum - 1, maximum]) {
                const bytes = freeFrames(base, count, rateIndex, mode, crc, pads);
                await expect(countMp3Frames(chunks(bytes, [1, 7, 4096]))).resolves.toBe(count);
              }
              const bytes = freeFrames(maximum + 1, count, rateIndex, mode, crc, pads);
              await expect(countMp3Frames(chunks(bytes, [1, 7, 4096]))).rejects.toMatchObject({
                kind: 'unsupported-format',
                offset: 0,
              });
            }
        }
    },
  );

  it.each([0, 1, 2])(
    'does not impose the indexed 32 kb/s minimum at rate %i',
    async (rateIndex) => {
      for (const chunkSize of [1, 4096])
        await expect(
          countMp3Frames(chunks(freeFrames(40, 4, rateIndex, 0, true, [1, 0]), [chunkSize])),
        ).resolves.toBe(4);
    },
  );
});
