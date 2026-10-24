import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { isVbrHeaderFrame } from '../src/mp3/vbr-header.js';
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
const count = (bytes: Uint8Array, includeVbrHeaderFrame: boolean) =>
  countMp3Frames(chunks(bytes, [3, 17, 1]), { includeVbrHeaderFrame });

/** Real encoders fill side information; zero filler hides misplaced field reads. */
function withSideInformation(bytes: Buffer): Buffer {
  bytes.fill(0xa5, 4, 36);
  return bytes;
}

/** Free-format frames have no table-defined length, so any exact size is possible. */
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
    'counts an initial %s header by default but can exclude it',
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

  it('does not trust a marker without valid flags or within a malformed frame', async () => {
    const badFlags = tag('Xing');
    badFlags.writeUInt32BE(0x10000000, 40);
    expect(isVbrHeaderFrame(badFlags)).toBe(false);
    const badFrame = Buffer.from(tag('Info'));
    badFrame[0] = 0;
    expect(isVbrHeaderFrame(badFrame)).toBe(false);
    expect(isVbrHeaderFrame(badFrame.subarray(0, 30))).toBe(false);
  });

  it('rejects truncated Xing optional fields and invalid VBRI TOC layout', () => {
    const xing = tag('Xing');
    xing.write('Xing', xing.length - 7, 'ascii');
    const onlyMarker = frame();
    onlyMarker.write('Xing', 36, 'ascii');
    onlyMarker.writeUInt32BE(0x00000010, 40);
    expect(isVbrHeaderFrame(onlyMarker)).toBe(false);
    const vbri = tag('VBRI');
    vbri.writeUInt16BE(999, 36 + 18);
    expect(isVbrHeaderFrame(vbri)).toBe(false);
    expect(isVbrHeaderFrame(xing)).toBe(true);
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
    expect(isVbrHeaderFrame(bytes)).toBe(true);
  });

  it('rejects Xing flags whose declared optional fields cannot fit the frame', () => {
    // 32 kbps / 48 kHz => 96-byte MPEG frame, too short for a 100-byte TOC.
    const short = frame({ bitrateIndex: 1, sampleRateIndex: 1 });
    short.write('Xing', 36, 'ascii');
    short.writeUInt32BE(4, 40);
    expect(isVbrHeaderFrame(short)).toBe(false);
  });

  it('rejects a free-format Xing signature with no room for its flags', () => {
    const short = Buffer.alloc(25, 0x11);
    short.set([0xff, 0xfb, 0x00, 0xc4]);
    short.write('Xing', 21, 'ascii');
    expect(isVbrHeaderFrame(short)).toBe(false);
  });

  it('validates VBRI version and independent TOC bounds', () => {
    const wrongVersion = tag('VBRI');
    wrongVersion.writeUInt16BE(2, 40);
    expect(isVbrHeaderFrame(wrongVersion)).toBe(false);
    const noEntries = tag('VBRI');
    noEntries.writeUInt16BE(0, 36 + 18);
    expect(isVbrHeaderFrame(noEntries)).toBe(false);
    const zeroWidth = tag('VBRI');
    zeroWidth.writeUInt16BE(0, 36 + 22);
    expect(isVbrHeaderFrame(zeroWidth)).toBe(false);
    const invalidWidth = tag('VBRI');
    invalidWidth.writeUInt16BE(5, 36 + 22);
    expect(isVbrHeaderFrame(invalidWidth)).toBe(false);
    const tooLong = tag('VBRI');
    tooLong.writeUInt16BE(99, 36 + 18);
    tooLong.writeUInt16BE(4, 36 + 22);
    expect(isVbrHeaderFrame(tooLong)).toBe(false);
  });

  it('does not read outside short free-format VBRI headers', () => {
    const short = Buffer.alloc(40, 0x11);
    short.set([0xff, 0xfb, 0, 0x04]);
    short.write('VBRI', 36);
    expect(isVbrHeaderFrame(short)).toBe(false);
  });

  it.each([0, 1, 2, 4, 8, 15])(
    'accepts Xing fields (mask %#b) that exactly fill the frame, not one byte more',
    (flags) => {
      const required = 36 + 8 + xingFieldBytes(flags);
      const exact = freeFormatXing(required, flags);
      expect(isVbrHeaderFrame(exact)).toBe(true);
      expect(isVbrHeaderFrame(exact.subarray(0, required - 1))).toBe(false);
    },
  );

  it('requires every Xing signature byte, not a partial match', () => {
    const partial = tag('Xing');
    partial.write('Xyyy', 36, 'ascii');
    expect(isVbrHeaderFrame(partial)).toBe(false);
  });

  it('requires the exact VBRI signature', () => {
    const wrongSignature = tag('VBRI');
    wrongSignature.write('VBRX', 36, 'ascii');
    expect(isVbrHeaderFrame(wrongSignature)).toBe(false);
  });

  it('reads VBRI version and TOC fields at their offsets despite filled side information', () => {
    expect(isVbrHeaderFrame(withSideInformation(tag('VBRI')))).toBe(true);
  });

  it('accepts a one-byte VBRI TOC entry width and a TOC that exactly fills the frame', () => {
    const exact = tag('VBRI');
    exact.writeUInt16BE(1, 36 + 22);
    exact.writeUInt16BE(exact.length - 62, 36 + 18);
    expect(isVbrHeaderFrame(exact)).toBe(true);
    exact.writeUInt16BE(exact.length - 61, 36 + 18);
    expect(isVbrHeaderFrame(exact)).toBe(false);
  });

  it('requires the buffer to span exactly one indexed MPEG frame', () => {
    const genuine = tag('Xing');
    expect(isVbrHeaderFrame(genuine)).toBe(true);
    expect(isVbrHeaderFrame(Buffer.concat([genuine, Buffer.alloc(1)]))).toBe(false);
    expect(isVbrHeaderFrame(genuine.subarray(0, genuine.length - 1))).toBe(false);
  });

  it('looks for Xing after a CRC only in CRC-protected frames', () => {
    const unprotected = frame();
    unprotected.write('Xing', 38, 'ascii');
    expect(isVbrHeaderFrame(unprotected)).toBe(false);
    expect(isVbrHeaderFrame(frame({ hasCrc: true }))).toBe(false);
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
