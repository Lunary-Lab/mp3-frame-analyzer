import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks } from './helpers/mp3-fixtures.js';
import { metadataTag, metadataV1 } from './helpers/metadata-fixtures.js';

function free(base = 417, padding = 0, channel = 3, crc = false): Buffer {
  const bytes = Buffer.alloc(base + padding, 0x11);
  bytes.set([255, crc ? 250 : 251, padding << 1, channel << 6]);
  return bytes;
}
const count = (parts: Buffer[]) => countMp3Frames(chunks(Buffer.concat(parts), [1, 19, 127]));

/** Independent v2.4 title envelope of an exact total length, without padding. */
function sizedTag(length: number): Buffer {
  const bytes = Buffer.alloc(length, 65);
  const size = (value: number) => [
    value >>> 21,
    (value >>> 14) & 127,
    (value >>> 7) & 127,
    value & 127,
  ];
  bytes.set([73, 68, 51, 4, 0, 16, ...size(length - 20)]);
  bytes.set([84, 73, 84, 50, ...size(length - 30), 0, 0, 0], 10);
  bytes.set(bytes.subarray(0, 10), length - 10);
  bytes.set([51, 68, 73], length - 10);
  return bytes;
}

describe('bounded free-format metadata acquisition', () => {
  it('anchors one- and two-frame streams with ID3v1 alone', async () => {
    for (const span of [417, 730]) {
      for (const number of [1, 2]) {
        expect(
          await count([...Array.from({ length: number }, () => free(span)), metadataV1(7)]),
        ).toBe(number);
      }
    }
  });

  it('validates each short frame prefix and preserves the acquisition error offset', async () => {
    for (const crc of [false, true]) {
      await expect(count([free(24), free(24, 0, 0, crc)])).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: 0,
      });
    }
  });

  it('distinguishes a complete payload header from a three-byte prefix crossing a frame boundary', async () => {
    const complete = free();
    complete.set([255, 251, 0, 192], complete.length - 4);
    await expect(count([complete])).rejects.toMatchObject({ kind: 'unsupported-format' });
    const prefix = free();
    prefix.set([255, 251, 0], prefix.length - 3);
    expect(await count([prefix, free()])).toBe(2);
  });

  it('reports the first footerless appended tag, not the last one', async () => {
    await expect(
      count([free(), free(), free(), metadataTag(3), metadataTag(2)]),
    ).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: 3 * 417,
    });
  });

  it('treats an exact ten-byte validated header with a missing body as truncation', async () => {
    await expect(
      count([free(), metadataTag(4, { footer: true }).subarray(0, 10)]),
    ).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });

  it('ranks MPEG-header evidence before a shorter chain with more metadata', async () => {
    // Known structural partition: 4 × 128. The alternative 3 × 140 has two
    // 46-byte tags, but its lower MPEG-header count must not win.
    const bytes = Buffer.alloc(512, 0x11);
    for (const offset of [0, 128, 256, 384, 186, 372]) bytes.set([255, 251, 0, 192], offset);
    bytes.set(sizedTag(46), 140);
    bytes.set(sizedTag(46), 326);
    expect(await count([bytes])).toBe(4);
  });

  it('uses metadata evidence to rank equally long header chains', async () => {
    // Three 128-byte frames + one 200-byte tag compete with three 170-byte
    // frames + two 37-byte tags. The latter has stronger metadata evidence.
    // Both physical counts are 3, but only a 170-byte first frame fits the
    // declared 100-byte Xing TOC, making the selected bound observable.
    const bytes = Buffer.alloc(584, 0x11);
    bytes.set(sizedTag(200), 128);
    bytes.set(sizedTag(37), 170);
    bytes.set(sizedTag(37), 377);
    for (const offset of [0, 328, 456, 207, 414]) bytes.set([255, 251, 0, 192], offset);
    bytes.write('Info', 21);
    bytes.writeUInt32BE(4, 25);
    expect(await count([bytes])).toBe(3);
    expect(
      await countMp3Frames(chunks(bytes, [1, 19, 127]), { includeVbrHeaderFrame: false }),
    ).toBe(2);
  });

  it('does not gain a header by moving backward across final ID3v1 metadata', async () => {
    // Four 200-byte frames outrank three 224-byte frames + ID3v1. A payload
    // decoy 128 bytes before the tag must not become a fourth candidate header.
    const bytes = Buffer.alloc(800, 0x11);
    bytes.set(metadataV1(), 672);
    for (const offset of [0, 200, 400, 600, 224, 448, 544]) bytes.set([255, 251, 0, 192], offset);
    expect(await count([bytes])).toBe(4);
  });

  it('includes a validated final ID3v1 in metadata evidence', async () => {
    // Three 140-byte frames + ID3v1 compete with three 182-byte frames whose
    // last two padding bits are set. The validated final tag selects 140;
    // a complete flags=15 Xing structure needs 141 bytes in a mono frame.
    const bytes = Buffer.alloc(548, 0x11);
    bytes.set(metadataV1(), 420);
    for (const offset of [0, 140, 280]) bytes.set([255, 251, 0, 192], offset);
    for (const offset of [182, 365]) bytes.set([255, 251, 2, 192], offset);
    bytes.write('Info', 21);
    bytes.writeUInt32BE(15, 25);
    expect(await count([bytes])).toBe(3);
    expect(
      await countMp3Frames(chunks(bytes, [1, 19, 127]), { includeVbrHeaderFrame: false }),
    ).toBe(3);
  });

  it('keeps a fixed span across tags before, during and after acquisition', async () => {
    for (const version of [2, 3, 4] as const) {
      const tag = metadataTag(version);
      const tail = metadataTag(4, { footer: true });
      expect(
        await count([tag, free(), tag, free(417, 1), tag, free(), tag, free(), tail, metadataV1()]),
      ).toBe(4);
    }
  });

  it('does not count metadata payload syncs as frame evidence', async () => {
    const tag = metadataTag(4, { padding: 100 });
    // Put a sync in a binary title record, not padding, with correct frame size.
    tag.set([255, 251, 0, 192], 25);
    tag.set([0, 0, 0, 102], 14);
    expect(await count([free(), tag, free()])).toBe(2);
  });

  it('rejects short candidates too small for nonmono mandatory side information', async () => {
    for (const crc of [false, true]) {
      for (const length of [24, crc ? 37 : 35]) {
        await expect(count([free(length, 0, 0, crc)])).rejects.toMatchObject({
          kind: 'unsupported-format',
        });
      }
      expect(await count([free(crc ? 38 : 36, 0, 0, crc)])).toBe(1);
    }
  });

  it('rejects alternate compatible headers and plausible metadata prefixes inside short payloads', async () => {
    for (const [marker, kind] of [
      [Buffer.from([255, 251, 0, 192]), 'unsupported-format'],
      [Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 4, 0]), 'truncated-mp3'],
    ] as const) {
      const bytes = free();
      bytes.set(marker, 80);
      await expect(count([bytes])).rejects.toMatchObject({ kind });
    }
  });

  it('does not swallow an exact three-byte incomplete metadata signature at EOF', async () => {
    for (const signature of ['ID3', 'TAG']) {
      await expect(count([free(), Buffer.from(signature)])).rejects.toMatchObject({
        kind: 'unsupported-format',
      });
    }
  });

  it('distinguishes plausible truncated tails from invalid or unsupported envelopes', async () => {
    const valid = metadataTag(4, { footer: true });
    const badVersion = Buffer.from(valid);
    badVersion[3] = 5;
    const badFlags = Buffer.from(valid);
    badFlags[5] = 1;
    const badSize = Buffer.from(valid);
    badSize[6] = 128;
    const badFooter = Buffer.from(valid);
    badFooter[badFooter.length - 1] = 9;
    // No established span: invalid/unsupported envelopes may be ancillary
    // data, not determinable malformed tags. Locked boundaries remain strict.
    for (const tag of [badVersion, badFlags, badSize, badFooter]) {
      expect(await count([free(), tag])).toBe(1);
      await expect(count([free(), free(), free(), tag])).rejects.toMatchObject({
        kind: tag === badVersion ? 'unsupported-format' : 'invalid-mp3',
      });
    }
    for (const tag of [valid.subarray(0, 5), metadataV1().subarray(0, 127)]) {
      await expect(count([free(), tag])).rejects.toMatchObject({ kind: 'unsupported-format' });
    }
    await expect(count([free(), valid.subarray(0, valid.length - 1)])).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });

  it('crosses repeated tags during acquisition and after lock without a count cap', async () => {
    for (const number of [9, 32, 300]) {
      const tags = Array.from({ length: number }, () => metadataTag(4, { footer: true }));
      expect(await count([free(), ...tags])).toBe(1);
      expect(await count([free(), ...tags, free(), ...tags, free(), ...tags])).toBe(3);
    }
  });

  it('counts a singleton despite same-count frame-versus-tail boundary interpretations', async () => {
    const tail = metadataTag(4, { footer: true });
    // One 417-byte frame + metadata, or one larger frame swallowing the same
    // bytes, both imply physical count 1; validated metadata evidence wins.
    expect(await count([free(), tail, metadataV1()])).toBe(1);
  });

  it('does not accept a no-footer tag as a trailing EOF anchor', async () => {
    await expect(count([free(), metadataTag(4)])).rejects.toMatchObject({
      kind: 'unsupported-format',
    });
  });

  it('rejects equally supported candidates that imply different physical counts', async () => {
    // Two complete structural partitions share EOF: 36×2800 and 35×2880.
    // The bounded probe contains four headers from each, with equal evidence.
    // These are alternative header partitions, not asserted decodable audio.
    const bytes = Buffer.alloc(100800, 0x11);
    for (const span of [2800, 2880]) {
      for (let offset = 0; offset < bytes.length; offset += span) {
        bytes.set([255, 251, 0, 192], offset);
      }
    }
    await expect(count([bytes])).rejects.toMatchObject({ kind: 'unsupported-format', offset: 0 });
  });

  it('preserves known final-frame truncation once at least three headers establish a span', async () => {
    await expect(count([free(), free(), free().subarray(0, 50)])).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });
});
