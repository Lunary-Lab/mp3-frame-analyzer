import { describe, expect, it } from 'vitest';
import { parseId3Header, isId3v1Tag } from '../src/mp3/id3.js';
import { id3v1, id3v2, synchsafe } from './helpers/mp3-fixtures.js';

describe('ID3 tag parsing', () => {
  it.each([2, 3, 4] as const)('decodes ID3v2.%i metadata length', (version) => {
    const tag = id3v2(Buffer.alloc(16385), version);
    expect(parseId3Header(tag, 0)).toEqual({
      bodyLength: 16385,
      totalLength: tag.length,
      hasFooter: false,
    });
  });

  it('recognizes optional ID3v2.4 footer', () => {
    const tag = id3v2(Buffer.alloc(12), 4, true);
    expect(parseId3Header(tag, 0)).toEqual({
      bodyLength: 12,
      totalLength: 32,
      hasFooter: true,
    });
  });

  it('does not interpret non-ID3 data as ID3 metadata', () => {
    expect(parseId3Header(Buffer.from('NO TAG HERE'), 0)).toBeNull();
    expect(isId3v1Tag(id3v1())).toBe(true);
    expect(isId3v1Tag(Buffer.from('NO TAG'))).toBe(false);
  });

  it('rejects impossible synchsafe sizes, unsupported versions and reserved flags', () => {
    const highBit = id3v2(Buffer.alloc(1));
    highBit[6] = 0x80;
    expect(() => parseId3Header(highBit, 0)).toThrow(/synchsafe/);

    const unknownVersion = id3v2(Buffer.alloc(1));
    unknownVersion[3] = 6;
    expect(() => parseId3Header(unknownVersion, 0)).toThrow(/version/);

    const reservedFlags = id3v2(Buffer.alloc(1));
    reservedFlags[5] = 0x01;
    expect(() => parseId3Header(reservedFlags, 0)).toThrow(/flags/);
    expect(() => parseId3Header(Buffer.from('ID3'), 0)).toThrow(/Incomplete/);
  });

  it('produces 28-bit synchsafe big-endian values', () => {
    expect([...synchsafe(0x12345)]).toEqual([0, 4, 70, 69]);
  });
});
