import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { isVbrHeaderFrame } from '../src/mp3/vbr-header.js';
import { chunks, frame, id3v2, mp3 } from './helpers/mp3-fixtures.js';

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

  it('recognizes a single Xing metadata frame without subsequent audio', async () => {
    const bytes = tag('Xing');
    expect(await count(bytes, true)).toBe(1);
    expect(await count(bytes, false)).toBe(0);
  });
});
