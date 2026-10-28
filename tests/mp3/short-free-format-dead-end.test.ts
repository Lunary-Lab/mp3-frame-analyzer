import { expect, it } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { chunks } from '../helpers/mp3-fixtures.js';
import { metadataTag } from '../helpers/metadata-fixtures.js';

function silent(base: number, count = 1): Buffer {
  const bytes = Buffer.alloc(base * count);
  for (let offset = 0; offset < bytes.length; offset += base) bytes.set([255, 251, 4, 192], offset);
  return bytes;
}

function footerTag(length: number): Buffer {
  const tag = Buffer.alloc(length, 65);
  tag.set([73, 68, 51, 4, 0, 16, 0, 0, 0, length - 20]);
  tag.set([84, 73, 84, 50, 0, 0, 0, length - 30, 0, 0, 0], 10);
  tag.set([51, 68, 73, 4, 0, 16, 0, 0, 0, length - 20], length - 10);
  return tag;
}

it.each([1, 7, 4096])(
  'ignores a dead-end ancillary header in a complete free-format singleton (chunks %i)',
  async (size) => {
    const original = silent(864);
    const altered = Buffer.from(original);
    altered.set([255, 251, 4, 192], 100);
    expect(altered.subarray(0, 21)).toEqual(original.subarray(0, 21));
    expect(await countMp3Frames(chunks(original, [size]))).toBe(1);
    expect(await countMp3Frames(chunks(altered, [size]))).toBe(1);
  },
);

it.each([2, 3])('preserves a complete %i-frame partition of 864 bytes', async (count) => {
  for (const size of [1, 7, 4096])
    expect(await countMp3Frames(chunks(silent(864 / count, count), [size]))).toBe(count);
});

it.each([1, 7, 4096])(
  'ignores a closed alternate with impossible side fields (chunks %i)',
  async (size) => {
    const original = silent(864);
    const bytes = Buffer.from(original);
    for (const offset of [100, 432]) bytes.set([255, 251, 4, 192], offset);
    // The alternate second frame switches windows with forbidden block_type 0.
    // These bytes are ancillary data under the original singleton layout.
    bytes[442] = 0x10;
    expect(bytes.subarray(0, 21)).toEqual(original.subarray(0, 21));
    await expect(countMp3Frames(chunks(bytes, [size]))).resolves.toBe(1);
    bytes[442] = 0;
    await expect(countMp3Frames(chunks(bytes, [size]))).resolves.toBe(2);
  },
);

it('admits alternate main-data capacity at the exact bound, but not one bit over', async () => {
  for (const extraBit of [0, 1]) {
    const bytes = silent(864);
    for (const offset of [100, 432]) bytes.set([255, 251, 4, 192], offset);
    // The second 432-byte mono frame has 411 payload bytes, or 3,288 bits.
    // Its declared granule length is ancillary data in the singleton layout.
    for (let index = 0; index < 12; index++) {
      const bit = 436 * 8 + 18 + index;
      bytes[bit >>> 3]! |= (((3288 + extraBit) >>> (11 - index)) & 1) << (7 - (bit & 7));
    }
    for (const size of [1, 7, 4096])
      await expect(countMp3Frames(chunks(bytes, [size]))).resolves.toBe(extraBit === 0 ? 2 : 1);
  }
});

it.each([0, 1, 2])(
  'resolves dead ends across short prefixes at sample-rate index %i',
  async (rate) => {
    for (const mode of [0, 1, 2, 3]) {
      for (const crc of [false, true]) {
        for (const padding of [0, 1]) {
          for (const count of [1, 2]) {
            const base = count === 1 ? 864 : 432;
            const frames = Array.from({ length: count }, () => {
              const bytes = Buffer.alloc(base + padding);
              bytes.set([255, crc ? 250 : 251, (rate << 2) | (padding << 1), mode << 6]);
              bytes.set([255, 251, rate << 2, 192], 100);
              return bytes;
            });
            for (const size of [1, 7, 4096])
              expect(await countMp3Frames(chunks(Buffer.concat(frames), [size]))).toBe(count);
          }
        }
      }
    }
  },
);

it('keeps crossing complete short layouts conservative even when one swallows metadata', async () => {
  // Two 400-byte frames plus a 64-byte footer-bearing tag compete with two
  // 432-byte frames. Their first successor headers cross one another's payload.
  const bytes = Buffer.alloc(864);
  for (const offset of [0, 400, 432]) bytes.set([255, 251, 4, 192], offset);
  bytes.set(footerTag(64), 800);
  for (const size of [1, 7, 4096])
    await expect(countMp3Frames(chunks(bytes, [size]))).rejects.toMatchObject({
      kind: 'unsupported-format',
    });
});

it('retains a complete alternate header five bytes after another frame boundary', async () => {
  // Two 600-byte frames with a 22-byte embedded tag and a 32-byte appended
  // tag compete with two 627-byte frames. The second headers are at 622/627;
  // both walks pass necessary side-information capacity checks.
  const bytes = Buffer.concat([silent(600), metadataTag(4), silent(600), footerTag(32)]);
  expect(bytes.length).toBe(1254);
  bytes.set([255, 251, 4, 192], 627);
  for (const size of [1, 7, 4096])
    await expect(countMp3Frames(chunks(bytes, [size]))).rejects.toMatchObject({
      kind: 'unsupported-format',
    });
});

it.each([1, 7, 4096])(
  'ignores impossible side fields in an alternate crossing a tagged layout (chunks %i)',
  async (size) => {
    const bytes = Buffer.alloc(864);
    for (const offset of [0, 400, 432]) bytes.set([255, 251, 4, 192], offset);
    bytes.set(footerTag(64), 800);
    bytes[442] = 0x10;
    await expect(countMp3Frames(chunks(bytes, [size]))).resolves.toBe(2);
  },
);

it('excludes an oversized padded alternate from the fallback veto evidence', async () => {
  const bytes = Buffer.concat([silent(900, 2), footerTag(121)]);
  // This alternate closes EOF at 960 + 961, but its second physical span
  // exceeds the 48 kHz limit. It cannot veto two 900-byte frames and a tag.
  bytes.set([255, 251, 6, 192], 960);
  for (const size of [1, 7, 4096]) expect(await countMp3Frames(chunks(bytes, [size]))).toBe(2);
});

it('does not use the EOF fallback to swallow plausible metadata or a different configuration', async () => {
  for (const marker of [
    metadataTag(4),
    Buffer.from([255, 251, 8, 192]),
    Buffer.from([255, 251, 0x94, 192]),
  ]) {
    const bytes = silent(864);
    bytes.set([255, 251, 4, 192], 100);
    bytes.set(marker, 500);
    for (const size of [1, 7, 4096])
      await expect(countMp3Frames(chunks(bytes, [size]))).rejects.toMatchObject({
        kind: 'unsupported-format',
      });
  }
});

it('preserves established three-header inference even when its final frame is incomplete', async () => {
  const bytes = silent(300, 3).subarray(0, 864);
  for (const size of [1, 7, 4096])
    await expect(countMp3Frames(chunks(bytes, [size]))).rejects.toMatchObject({
      kind: 'truncated-mp3',
      offset: 864,
    });
});

it('requires newly rescued frames to fit their declared main-data bits exactly', async () => {
  for (const extraBit of [0, 1]) {
    const bytes = silent(864);
    bytes.set([255, 251, 4, 192], 100);
    // Mono side information starts after four bytes. With zero reservoir,
    // the 843-byte payload fits 6,744 bits, but not 6,745.
    for (const [start, value] of [
      [18, 4095],
      [77, 2649 + extraBit],
    ]) {
      for (let index = 0; index < 12; index++) {
        const bit = 32 + start! + index;
        bytes[bit >>> 3]! |= ((value! >>> (11 - index)) & 1) << (7 - (bit & 7));
      }
    }
    for (const size of [1, 7, 4096]) {
      const result = countMp3Frames(chunks(bytes, [size]));
      if (extraBit === 0) await expect(result).resolves.toBe(1);
      else await expect(result).rejects.toMatchObject({ kind: 'unsupported-format' });
    }
  }
});
