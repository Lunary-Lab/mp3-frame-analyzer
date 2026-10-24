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
  it('handles short ID3 signatures and exposes exact typed validation errors', () => {
    expect(parseId3Header(Buffer.alloc(0), 3)).toBeNull();
    expect(parseId3Header(Buffer.from('ID'), 3)).toBeNull();
    expect(() => parseId3Header(Buffer.from('ID3'), 10)).toThrow(/Incomplete/);

    for (const version of [0, 1, 5, 255]) {
      const bytes = id3v2(Buffer.alloc(1));
      bytes[3] = version;
      try {
        parseId3Header(bytes, 77);
        throw new Error('Expected unsupported-format error');
      } catch (error) {
        expect(error).toMatchObject({ kind: 'unsupported-format', offset: 77 });
      }
    }

    for (const index of [6, 7, 8, 9]) {
      const bytes = id3v2(Buffer.alloc(1));
      bytes[index] = 0x80;
      try {
        parseId3Header(bytes, 100);
        throw new Error('Expected invalid-mp3 error');
      } catch (error) {
        expect(error).toMatchObject({
          kind: 'invalid-mp3',
          offset: 100 + index,
          message: 'Invalid synchsafe ID3v2 size',
        });
      }
    }

    for (const [version, invalidFlag] of [
      [2, 0x20],
      [3, 0x10],
      [4, 0x01],
    ] as const) {
      const bytes = id3v2(Buffer.alloc(1), version);
      bytes[5] = invalidFlag;
      expect(() => parseId3Header(bytes, 13)).toThrow(/Reserved ID3v2 flags/);
      try {
        parseId3Header(bytes, 13);
      } catch (error) {
        expect(error).toMatchObject({ kind: 'invalid-mp3', offset: 13 });
      }
    }
  });

  it('recognizes exactly the TAG prefix (including three-byte input)', () => {
    expect(isId3v1Tag(Buffer.from('TAG'))).toBe(true);
    expect(isId3v1Tag(Buffer.from('TAG-anything'))).toBe(true);
    for (const candidate of ['TA', 'TAG'.slice(0, 1), 'XAG', 'TBG', 'TAH', 'XXG', 'TXG']) {
      expect(isId3v1Tag(Buffer.from(candidate))).toBe(false);
    }
  });
});
