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

  it('matches all three ID3 signature bytes, individually and together', () => {
    for (const signature of ['XD3', 'IX3', 'IDX', 'XXX', 'IXX', 'XX3', 'ID4', 'I33']) {
      const bytes = Buffer.concat([Buffer.from(signature), Buffer.alloc(8)]);
      expect(parseId3Header(bytes, 0)).toBeNull();
    }
  });

  it('preserves the kind, offset, and message for a truncated ID3 header', () => {
    try {
      parseId3Header(Buffer.from('ID3'), 82);
      throw new Error('Expected truncated ID3 error');
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'truncated-mp3',
        offset: 82,
        message: 'Incomplete ID3v2 header',
      });
    }
  });

  it('rejects ID3v2 revision 0xff but accepts other revision values', () => {
    const invalid = id3v2(Buffer.alloc(1), 4);
    invalid[4] = 0xff;
    expect(() => parseId3Header(invalid, 19)).toThrow(/Unsupported ID3v2 version/);
    try {
      parseId3Header(invalid, 19);
      throw new Error('Expected unsupported revision');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'unsupported-format', offset: 19 });
    }
    const valid = id3v2(Buffer.alloc(1), 4);
    valid[4] = 0xfe;
    expect(parseId3Header(valid, 19)).toMatchObject({ bodyLength: 1 });
  });

  it('allows ID3v2.3 defined experimental flag while rejecting it in ID3v2.2', () => {
    const v3 = id3v2(Buffer.alloc(1), 3);
    v3[5] = 0x20;
    expect(parseId3Header(v3, 12)).toEqual({
      bodyLength: 1,
      totalLength: 11,
      hasFooter: false,
    });
    const v2 = id3v2(Buffer.alloc(1), 2);
    v2[5] = 0x20;
    expect(() => parseId3Header(v2, 12)).toThrow(/Reserved ID3v2 flags/);
  });

  it('reads precisely the four synchsafe length bytes and never inspects tag body', () => {
    const bytes = id3v2(Buffer.from([0x80, 0x80]), 4);
    expect(parseId3Header(bytes, 0)).toEqual({
      bodyLength: 2,
      totalLength: 12,
      hasFooter: false,
    });
  });
});
