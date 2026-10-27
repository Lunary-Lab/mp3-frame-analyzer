import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { isEncoderFrame } from '../../src/mp3/encoder-frame.js';
import type { FreeFormatFrameHeader } from '../../src/mp3/frame-header.js';
import {
  id3v11,
  indexedFrame,
  layouts,
  titleTag,
  vbriFrame,
  withPairedTags,
  xingFields,
  xingFrame,
  xingPosition,
  type Layout,
} from '../helpers/encoder-layouts.js';
import { chunks } from '../helpers/mp3-fixtures.js';

const partitions = [[1], [3, 17, 2, 101], [4096]] as const;
const flags = Array.from({ length: 16 }, (_, i) => i);
const base: Layout = { channel: 0, crc: false, crcShift: 0, padding: 0 };

/** Direct recognition isolates exact field bounds from free-format span discovery. */
function recognized(bytes: Uint8Array, layout: Layout): boolean {
  const header: FreeFormatFrameHeader = {
    kind: 'free-format',
    sampleRateIndex: 0,
    mono: layout.channel === 3,
    hasCrc: layout.crc,
    padding: layout.padding,
  };
  return isEncoderFrame(header, bytes);
}

async function assertPolicies(bytes: Buffer, expected: number, excluded: number): Promise<void> {
  for (const sizes of partitions) {
    expect(await countMp3Frames(chunks(bytes, sizes))).toBe(expected);
    expect(await countMp3Frames(chunks(bytes, sizes), { includeVbrHeaderFrame: true })).toBe(
      expected,
    );
    expect(await countMp3Frames(chunks(bytes, sizes), { includeVbrHeaderFrame: false })).toBe(
      excluded,
    );
  }
}

describe('encoder-header layout matrix (structural, not an audio decoder)', () => {
  it.each(['Xing', 'Info'] as const)(
    '%s declared count zero or uint32-max cannot override physical traversal',
    async (kind) => {
      for (const declared of [0, 0xffffffff]) {
        for (const physical of [1, 3]) {
          const initial = xingFrame(kind, 1, base);
          initial.writeUInt32BE(declared, xingPosition(base) + 8);
          const bytes = Buffer.concat([
            initial,
            ...Array.from({ length: physical - 1 }, () => indexedFrame(base)),
          ]);
          await assertPolicies(bytes, physical, physical - 1);
        }
      }
    },
  );

  for (const kind of ['Xing', 'Info'] as const) {
    it.each(layouts)(
      `${kind}: channel $channel, CRC $crc, offset adjustment $crcShift, padding $padding`,
      async (layout) => {
        for (const mask of flags) {
          // The second encoder-like frame is physical audio for this policy:
          // exclusion can remove only the first MPEG frame, never every marker.
          const bytes = withPairedTags(
            Buffer.concat([
              xingFrame(kind, mask, layout),
              xingFrame('Info', 15, base),
              indexedFrame(base),
            ]),
          );
          await assertPolicies(bytes, 3, 2);
        }
      },
    );
  }

  it.each([1, 2, 3, 4] as const)(
    'VBRI TOC entry width %i across channel/CRC/padding',
    async (width) => {
      for (const layout of layouts.filter(({ crcShift }) => crcShift === 0)) {
        const bytes = withPairedTags(Buffer.concat([vbriFrame(layout, width), indexedFrame(base)]));
        await assertPolicies(bytes, 2, 1);
      }
    },
  );

  it.each(flags)('Xing and Info optional fields at exact end, mask %i', (mask) => {
    for (const kind of ['Xing', 'Info'] as const) {
      for (const layout of layouts) {
        const bytes = xingFrame(kind, mask, layout);
        // A direct-recognition free-format fixture has this explicit span.
        bytes[2] = layout.padding << 1;
        const end = xingPosition(layout) + 8 + xingFields(mask).length;
        expect(recognized(bytes.subarray(0, end), layout)).toBe(true);
        expect(recognized(bytes.subarray(0, end - 1), layout)).toBe(false);
      }
    }
  });

  it.each([1, 2, 3, 4] as const)('VBRI exact TOC end and one-byte-short width %i', (width) => {
    for (const layout of layouts.filter(({ crcShift }) => crcShift === 0)) {
      const bytes = vbriFrame(layout, width);
      bytes[2] = layout.padding << 1;
      const end = 62 + 3 * width;
      expect(recognized(bytes.subarray(0, end), layout)).toBe(true);
      expect(recognized(bytes.subarray(0, end - 1), layout)).toBe(false);
      expect(recognized(bytes.subarray(0, 61), layout)).toBe(false);
    }
  });

  it('does not count LAME as a standalone frame or trust its ancillary contents', async () => {
    const xing = xingFrame('Xing', 15, base);
    const extensionStart = xingPosition(base) + 8 + xingFields(15).length;
    const opaqueExtension = Buffer.alloc(36, 0x25);
    opaqueExtension.write('LAME3.100', 0, 'ascii');
    opaqueExtension.copy(xing, extensionStart);
    await assertPolicies(Buffer.concat([xing, indexedFrame(base)]), 2, 1);

    const withoutXing = indexedFrame(base);
    opaqueExtension.copy(withoutXing, xingPosition(base));
    await assertPolicies(withoutXing, 1, 1);
  });

  it('does not promote a later encoder marker to the first frame through metadata wrappers', async () => {
    for (const version of [2, 3, 4] as const) {
      const bytes = Buffer.concat([
        titleTag(version),
        indexedFrame(base),
        xingFrame('Xing', 15, base),
        vbriFrame(base, 2),
        id3v11(),
      ]);
      await assertPolicies(bytes, 3, 3);
    }
  });

  it('rejects incomplete physical encoder frames under both count policies', async () => {
    for (const bytes of [
      xingFrame('Xing', 15, base),
      xingFrame('Info', 0, base),
      vbriFrame(base, 4),
    ]) {
      for (const includeVbrHeaderFrame of [false, true]) {
        for (const sizes of partitions) {
          await expect(
            countMp3Frames(chunks(bytes.subarray(0, bytes.length - 1), sizes), {
              includeVbrHeaderFrame,
            }),
          ).rejects.toMatchObject({ kind: 'truncated-mp3' });
        }
      }
    }
  });

  it('does not recognize displaced Xing/Info or a CRC-adjusted offset in unprotected audio', async () => {
    for (const kind of ['Xing', 'Info'] as const) {
      for (const layout of layouts) {
        const bytes = indexedFrame(layout);
        const invalidOffset = (layout.channel === 3 ? 21 : 36) + (layout.crc ? 4 : 2);
        bytes.write(kind, invalidOffset, 'ascii');
        bytes.writeUInt32BE(0, invalidOffset + 4);
        expect(recognized(bytes, layout)).toBe(false);
        await assertPolicies(bytes, 1, 1);
      }
    }
  });

  it('rejects every reserved Xing flag bit without trusting the declared count', () => {
    for (let bit = 4; bit < 32; bit++) {
      const bytes = xingFrame('Xing', 15, base);
      bytes.writeUInt32BE((2 ** bit + 15) >>> 0, 40);
      expect(recognized(bytes, base)).toBe(false);
    }
  });
});

it.each(['Xing', 'Info', 'VBRI'] as const)(
  'preserves direct physical count of complete ID3 encoder records for %s',
  async (kind) => {
    const encoder = kind === 'VBRI' ? vbriFrame(base, 3) : xingFrame(kind, 15, base);
    const payload = withPairedTags(encoder);
    expect(await countMp3Frames(chunks(payload, [1]))).toBe(1);
  },
);
