import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { decodeFrameHeader } from '../src/mp3/frame-header.js';
import { isEncoderFrame } from '../src/mp3/encoder-frame.js';
import { chunks, frame, id3v1, id3v2, mp3 } from './helpers/mp3-fixtures.js';

function tag(
  kind: 'Xing' | 'Info' | 'VBRI',
  options: { mono?: boolean; crc?: boolean } = {},
): Buffer {
  const bytes = frame({ hasCrc: options.crc ?? false });
  if (options.mono) bytes[3] = (bytes[3]! & ~0xc0) | 0xc0;
  if (kind === 'VBRI') {
    bytes.write('VBRI', 36, 'ascii');
    bytes.writeUInt16BE(1, 40);
    bytes.writeUInt16BE(2, 36 + 18);
    bytes.writeUInt16BE(4, 36 + 22);
  } else {
    const position = (options.mono ? 21 : 36) + (options.crc ? 2 : 0);
    bytes.write(kind, position, 'ascii');
    bytes.writeUInt32BE(0x0000000f, position + 4);
  }
  return bytes;
}
/** Recognize a complete fixture frame, decoding its header as traversal does. */
function recognized(frame: Uint8Array): boolean {
  const header = decodeFrameHeader(frame);
  if (header.kind !== 'indexed' && header.kind !== 'free-format') {
    throw new Error('Fixture is not an MPEG-1 Layer III frame');
  }
  if (header.kind === 'indexed' && frame.length !== header.length) {
    throw new Error('Fixture is not exactly one indexed frame');
  }
  return isEncoderFrame(header, frame);
}
const count = (bytes: Uint8Array, includeVbrHeaderFrame: boolean) =>
  countMp3Frames(chunks(bytes, [3, 17, 1]), { includeVbrHeaderFrame });

/** Real encoders fill side information; zero filler hides misplaced field reads. */
function withSideInformation(bytes: Buffer): Buffer {
  bytes.fill(0xa5, 4, 36);
  return bytes;
}

/** Exact free-format fixture spans exercise metadata-field bounds without a bitrate table. */
function freeFormatXing(length: number, flags: number): Buffer {
  const bytes = Buffer.alloc(length, 0x11);
  bytes.set([0xff, 0xfb, 0x00, 0x04]);
  bytes.write('Xing', 36, 'ascii');
  bytes.writeUInt32BE(flags, 40);
  return bytes;
}

function xingFieldBytes(flags: number): number {
  return (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
}

describe('first MPEG frame encoder header policy', () => {
  it.each(['Info', 'Xing', 'VBRI'] as const)(
    'counts an initial %s header when explicitly included and can exclude it',
    async (kind) => {
      const audio = mp3([tag(kind), frame(), frame()], id3v2(Buffer.alloc(5)));
      expect(await count(audio, true)).toBe(3);
      expect(await count(audio, false)).toBe(2);
    },
  );

  it.each([false, true])('recognizes mono Xing with CRC protection %s', async (crc) => {
    const bytes = mp3([tag('Xing', { mono: true, crc }), frame()]);
    expect(await count(bytes, false)).toBe(1);
  });

  it('does not exclude metadata signatures in later frames or arbitrary payloads', async () => {
    const ordinary = frame();
    ordinary.write('Xing', 50, 'ascii');
    const bytes = mp3([ordinary, tag('Info'), tag('VBRI')]);
    expect(await count(bytes, false)).toBe(3);
  });

  it('does not trust a marker without valid flags', () => {
    const badFlags = tag('Xing');
    badFlags.writeUInt32BE(0x10000000, 40);
    expect(recognized(badFlags)).toBe(false);
  });

  it('rejects invalid Xing flags and oversized VBRI tables while ignoring a late marker', () => {
    const xing = tag('Xing');
    xing.write('Xing', xing.length - 7, 'ascii');
    const onlyMarker = frame();
    onlyMarker.write('Xing', 36, 'ascii');
    onlyMarker.writeUInt32BE(0x00000010, 40);
    expect(recognized(onlyMarker)).toBe(false);
    const vbri = tag('VBRI');
    vbri.writeUInt16BE(999, 36 + 18);
    expect(recognized(vbri)).toBe(false);
    expect(recognized(xing)).toBe(true);
  });

  it('preserves counts when leading ID3 metadata precedes the Xing header', async () => {
    const bytes = mp3([tag('Xing'), frame()], id3v2(Buffer.alloc(100)));
    expect(await count(bytes, false)).toBe(1);
  });

  it('does not exclude ordinary CBR without metadata', async () => {
    const bytes = mp3([frame(), frame()]);
    expect(await count(bytes, false)).toBe(2);
  });
  it.each([0, 1, 2, 4, 8, 15])('validates Xing optional fields mask %#b', (flags) => {
    const bytes = frame();
    bytes.write('Xing', 36, 'ascii');
    bytes.writeUInt32BE(flags, 40);
    expect(recognized(bytes)).toBe(true);
  });

  it('rejects Xing flags whose declared optional fields cannot fit the frame', () => {
    // 32 kbps / 48 kHz => 96-byte MPEG frame, too short for a 100-byte TOC.
    const short = frame({ bitrateIndex: 1, sampleRateIndex: 1 });
    short.write('Xing', 36, 'ascii');
    short.writeUInt32BE(4, 40);
    expect(recognized(short)).toBe(false);
  });

  it('rejects a free-format Xing signature with no room for its flags', () => {
    const short = Buffer.alloc(25, 0x11);
    short.set([0xff, 0xfb, 0x00, 0xc4]);
    short.write('Xing', 21, 'ascii');
    expect(recognized(short)).toBe(false);
  });

  it('validates VBRI version and independent TOC bounds', () => {
    const wrongVersion = tag('VBRI');
    wrongVersion.writeUInt16BE(2, 40);
    expect(recognized(wrongVersion)).toBe(false);
    const noEntries = tag('VBRI');
    noEntries.writeUInt16BE(0, 36 + 18);
    expect(recognized(noEntries)).toBe(false);
    const zeroWidth = tag('VBRI');
    zeroWidth.writeUInt16BE(0, 36 + 22);
    expect(recognized(zeroWidth)).toBe(false);
    const invalidWidth = tag('VBRI');
    invalidWidth.writeUInt16BE(5, 36 + 22);
    expect(recognized(invalidWidth)).toBe(false);
    const tooLong = tag('VBRI');
    tooLong.writeUInt16BE(99, 36 + 18);
    tooLong.writeUInt16BE(4, 36 + 22);
    expect(recognized(tooLong)).toBe(false);
  });

  it('does not read outside short free-format VBRI headers', () => {
    const short = Buffer.alloc(40, 0x11);
    short.set([0xff, 0xfb, 0, 0x04]);
    short.write('VBRI', 36);
    expect(recognized(short)).toBe(false);
  });

  it.each([0, 1, 2, 4, 8, 15])(
    'accepts Xing fields (mask %#b) that exactly fill the frame, not one byte more',
    (flags) => {
      const required = 36 + 8 + xingFieldBytes(flags);
      const exact = freeFormatXing(required, flags);
      expect(recognized(exact)).toBe(true);
      expect(recognized(exact.subarray(0, required - 1))).toBe(false);
    },
  );

  it('requires every Xing signature byte, not a partial match', () => {
    const partial = tag('Xing');
    partial.write('Xyyy', 36, 'ascii');
    expect(recognized(partial)).toBe(false);
  });

  it('requires the exact VBRI signature', () => {
    const wrongSignature = tag('VBRI');
    wrongSignature.write('VBRX', 36, 'ascii');
    expect(recognized(wrongSignature)).toBe(false);
  });

  it('reads VBRI version and TOC fields at their offsets despite filled side information', () => {
    expect(recognized(withSideInformation(tag('VBRI')))).toBe(true);
  });

  it('accepts a one-byte VBRI TOC entry width and a TOC that exactly fills the frame', () => {
    const exact = tag('VBRI');
    exact.writeUInt16BE(1, 36 + 22);
    exact.writeUInt16BE(exact.length - 62, 36 + 18);
    expect(recognized(exact)).toBe(true);
    exact.writeUInt16BE(exact.length - 61, 36 + 18);
    expect(recognized(exact)).toBe(false);
  });

  it('only recognizes a complete first frame; a truncated one is rejected', async () => {
    const genuine = tag('Xing');
    expect(recognized(genuine)).toBe(true);
    await expect(count(genuine.subarray(0, genuine.length - 1), false)).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });

  it('looks for Xing after a CRC only in CRC-protected frames', () => {
    const unprotected = frame();
    unprotected.write('Xing', 38, 'ascii');
    expect(recognized(unprotected)).toBe(false);
    expect(recognized(frame({ hasCrc: true }))).toBe(false);
  });

  it('excludes the header frame when the stream ends with ID3v1 metadata', async () => {
    const bytes = mp3([tag('Xing'), frame(), frame()], undefined, id3v1());
    expect(await count(bytes, true)).toBe(3);
    expect(await count(bytes, false)).toBe(2);
  });

  it('recognizes a single Xing metadata frame without subsequent audio', async () => {
    const bytes = tag('Xing');
    expect(await count(bytes, true)).toBe(1);
    expect(await count(bytes, false)).toBe(0);
  });
});
