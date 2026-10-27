import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { decodeFrameHeader } from '../src/mp3/frame-header.js';
import { chunks, frame, id3v2 } from './helpers/mp3-fixtures.js';
import { minimumFreeFrame } from './helpers/minimum-free-format-fixtures.js';
import {
  forbiddenId3Version,
  headerCases,
  headerIdentifier,
  indexedVariants,
  lockedFreeFormat,
  tagCases,
  tagVersion,
  unsupportedHeader,
} from './helpers/format-classification-fixtures.js';

const partitions = [[1], [2, 3, 7, 11], [4096]];
const count = (bytes: Uint8Array, sizes: number[]) => countMp3Frames(chunks(bytes, sizes));

function boundaryPrefixes(): Buffer[] {
  return [
    Buffer.alloc(0),
    id3v2(Buffer.alloc(7)),
    frame(),
    lockedFreeFormat(),
    Buffer.concat(Array.from({ length: 5 }, () => minimumFreeFrame(21))),
    Buffer.concat(Array.from({ length: 5 }, () => minimumFreeFrame(23, { crc: true }))),
  ];
}

// These positive fixtures establish header geometry/counts, not decoded-audio or CRC validity.
describe('supported structural MPEG-1 Layer III profile', () => {
  it.each([0, 1, 2])('counts every indexed geometry at rate index %i', async (rate) => {
    const variants = indexedVariants(rate);
    expect(variants).toHaveLength(224);
    const bytes = Buffer.concat(variants);
    for (const sizes of partitions) {
      expect(await count(bytes, sizes)).toBe(224);
      expect(await countMp3Frames(chunks(bytes, sizes), { includeVbrHeaderFrame: false })).toBe(
        224,
      );
    }
  });

  it('accepts all channel, mode-extension, nonreserved emphasis and ancillary header bits', async () => {
    const variants: Buffer[] = [];
    for (const channel of [0, 1, 2, 3]) {
      for (const extension of [0, 1, 2, 3]) {
        for (const emphasis of [0, 1, 3]) {
          for (let flags = 0; flags < 8; flags++) {
            const bytes = frame();
            bytes[2] = bytes[2]! | (flags & 1); // private bit
            bytes[3] = (channel << 6) | (extension << 4) | ((flags & 6) << 1) | emphasis;
            expect(decodeFrameHeader(bytes)).toMatchObject({
              kind: 'indexed',
              length: bytes.length,
            });
            variants.push(bytes);
          }
        }
      }
    }
    for (const sizes of partitions) expect(await count(Buffer.concat(variants), sizes)).toBe(384);
  });

  it.each([2, 3, 4] as const)('accepts every nonforbidden ID3v2.%i revision', async (version) => {
    const bytes = Buffer.concat([
      ...Array.from({ length: 255 }, (_, revision) => tagVersion(version, revision)),
      frame(),
    ]);
    for (const sizes of partitions) expect(await count(bytes, sizes)).toBe(1);
  });
});

describe('recognized unsupported identifiers versus malformed headers', () => {
  it.each(headerCases)(
    '$label preserves kind, message and offset across boundaries',
    async (test) => {
      const prefixes = boundaryPrefixes();
      for (const prefix of prefixes) {
        for (const sizes of partitions) {
          await expect(count(Buffer.concat([prefix, test.bytes]), sizes)).rejects.toMatchObject({
            name: 'Mp3ParseError',
            kind: test.kind,
            message: test.message,
            offset: prefix.length,
          });
        }
      }
    },
  );

  it.each(tagCases)('$label is classified at the tag start', async (test) => {
    for (const prefix of boundaryPrefixes()) {
      for (const sizes of partitions) {
        const bytes = Buffer.concat([prefix, test.bytes, frame()]);
        await expect(count(bytes, sizes)).rejects.toMatchObject({
          name: 'Mp3ParseError',
          kind: test.kind,
          message: test.message,
          offset: prefix.length,
        });
      }
    }
  });

  it('does not validate the unknown body layout of an unsupported MPEG family', async () => {
    const bytes = headerIdentifier(2, 1);
    bytes[2] = 0xfc;
    bytes[3] = 2;
    await expect(count(bytes, [1])).rejects.toMatchObject({
      kind: 'unsupported-format',
      offset: 0,
      message: unsupportedHeader,
    });
  });

  it('retains unknown-ID3 scope precedence but rejects forbidden identifiers first', async () => {
    const unknown = tagVersion(5);
    unknown[5] = 0xff;
    unknown[6] = 0xff;
    await expect(count(unknown, [1])).rejects.toMatchObject({
      kind: 'unsupported-format',
      offset: 0,
      message: 'Unsupported ID3v2 version',
    });
    unknown[4] = 0xff;
    await expect(count(unknown, [1])).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: 0,
      message: forbiddenId3Version,
    });
  });

  it('keeps the three-byte post-frame ID3 prefix under the trailing-header precedence', async () => {
    for (const prefix of [frame(), lockedFreeFormat()]) {
      for (const sizes of partitions) {
        await expect(
          count(Buffer.concat([prefix, Buffer.from('ID3')]), sizes),
        ).rejects.toMatchObject({
          kind: 'truncated-mp3',
          offset: prefix.length,
          message: 'Incomplete trailing frame header',
        });
      }
    }
  });

  it('requires the complete known-boundary ID3 header before examining identifiers', async () => {
    for (const version of [4, 5, 255]) {
      for (let length = 3; length < 10; length++) {
        const bytes = tagVersion(version, 255).subarray(0, length);
        for (const sizes of partitions) {
          await expect(count(bytes, sizes)).rejects.toMatchObject({
            kind: 'truncated-mp3',
            offset: 0,
            message: 'Incomplete ID3v2 tag header',
          });
        }
      }
    }
  });
});
