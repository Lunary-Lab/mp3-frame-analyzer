import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';

function writeBits(bytes: Uint8Array, offset: number, width: number, value: number): void {
  for (let index = 0; index < width; index++) {
    const bit = offset + index;
    const mask = 1 << (7 - (bit & 7));
    bytes[bit >> 3] = (bytes[bit >> 3]! & ~mask) | ((value >> (width - index - 1)) & 1 ? mask : 0);
  }
}

function singleton(
  alternate?: 'valid' | 'block-type' | 'huffman' | 'scalefactors',
  laterOnly = false,
) {
  const bytes = new Uint8Array(864);
  bytes.set([255, 251, 4, 192]); // 48 kHz mono; zero side information, 843 ancillary bytes.
  if (alternate !== undefined) {
    for (const offset of [216, 540]) {
      bytes.set([255, 251, 8, 192], offset); // Possible 32 kHz sequence in ancillary data.
      if (laterOnly && offset === 216) continue;
      for (const record of [18, 77]) {
        const bit = (offset + 4) * 8 + record;
        if (alternate === 'block-type') writeBits(bytes, bit + 33, 1, 1);
        if (alternate === 'huffman') {
          writeBits(bytes, bit + 12, 9, 1);
          writeBits(bytes, bit + 34, 5, 4);
        }
        if (alternate === 'scalefactors') writeBits(bytes, bit + 29, 4, 15);
      }
    }
  }
  return bytes;
}

async function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

describe.each([1, 7, 4096])(
  'new-sequence side-information evidence with %i-byte chunks',
  (size) => {
    it('retains the valid zero-main-data singleton without alternative headers', async () => {
      await expect(countMp3Frames(chunks(singleton(), size))).resolves.toBe(1);
    });

    it('retains ambiguity when the zero-data alternate really is possible', async () => {
      await expect(countMp3Frames(chunks(singleton('valid'), size))).rejects.toMatchObject({
        kind: 'unsupported-format',
        message: 'Ambiguous free-format MPEG frame layout',
        offset: 0,
      });
    });

    it.each(['block-type', 'huffman', 'scalefactors'] as const)(
      'does not reject a valid singleton because of impossible %s alternate fields',
      async (alternate) => {
        // Only the proved ancillary extent is changed. The singleton's complete
        // side information remains zero, with no reservoir or coded main data.
        await expect(countMp3Frames(chunks(singleton(alternate), size))).resolves.toBe(1);
      },
    );

    it.each(['block-type', 'huffman', 'scalefactors'] as const)(
      'checks the later alternate frame too, not only its initial %s fields',
      async (alternate) => {
        await expect(countMp3Frames(chunks(singleton(alternate, true), size))).resolves.toBe(1);
      },
    );
  },
);
