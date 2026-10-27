import { describe, expect, it } from 'vitest';
import { decodeFrameHeader } from '../src/mp3/frame-header.js';
import { Probe } from '../src/mp3/free-format-probe.js';

function writeBits(bytes: Uint8Array, offset: number, width: number, value: number): void {
  const bits = value.toString(2).padStart(width, '0');
  for (let index = 0; index < width; index++) {
    const bit = offset + index;
    const mask = 1 << (7 - (bit % 8));
    if (bits[index] === '1') bytes[Math.floor(bit / 8)]! |= mask;
    else bytes[Math.floor(bit / 8)]! &= ~mask;
  }
}

function candidate(mode: number, crc: boolean, lengths: number[], reservoir = 0, switched = false) {
  const prefix = 4 + (crc ? 2 : 0) + (mode === 3 ? 17 : 32);
  const bytes = new Uint8Array(prefix + 1);
  bytes.set([255, crc ? 250 : 251, 4, mode << 6]);
  const sideBit = (4 + (crc ? 2 : 0)) * 8;
  writeBits(bytes, sideBit, 9, reservoir);
  const firstRecord = mode === 3 ? 18 : 20;
  for (let index = 0; index < lengths.length; index++) {
    const record = sideBit + firstRecord + index * 59;
    writeBits(bytes, record, 12, lengths[index]!);
    if (switched) {
      writeBits(bytes, record + 33, 1, 1);
      writeBits(bytes, record + 34, 2, 2);
    }
  }
  const header = decodeFrameHeader(bytes.subarray(0, 4));
  if (header.kind !== 'free-format') throw new Error('Independent fixture header is invalid');
  return { bytes, header, prefix };
}

describe('necessary main-data capacity for proposed new sequence evidence', () => {
  it.each(
    [0, 1, 2, 3].flatMap((mode) =>
      [false, true].flatMap((crc) => [false, true].map((switched) => ({ mode, crc, switched }))),
    ),
  )(
    'checks aggregate bits, not separately rounded granules: mode=$mode CRC=$crc switch=$switched',
    ({ mode, crc, switched }) => {
      const lengths = mode === 3 ? [7, 1] : [1, 2, 3, 2];
      const exact = candidate(mode, crc, lengths, 0, switched);
      expect(
        new Probe(exact.bytes, true, exact.bytes.length).frameMayFit(
          0,
          exact.bytes.length,
          exact.header,
        ),
      ).toBe(true);
      lengths[lengths.length - 1]!++;
      const over = candidate(mode, crc, lengths, 0, switched);
      expect(
        new Probe(over.bytes, true, over.bytes.length).frameMayFit(
          0,
          over.bytes.length,
          over.header,
        ),
      ).toBe(false);
    },
  );

  it.each([0, 1, 2, 3])(
    'grants the claimed backward bytes without assuming a reset, mode=%i',
    (mode) => {
      const exact = candidate(mode, false, mode === 3 ? [2048, 2048] : [2048, 2048, 0, 0], 511);
      const probe = new Probe(exact.bytes, true, exact.bytes.length);
      // One current byte plus 511 backward bytes = 4096 bits.
      expect(probe.frameMayFit(0, exact.bytes.length, exact.header)).toBe(true);
      expect(probe.frameMayFit(0, exact.bytes.length - 1, exact.header)).toBe(false);
      // Repeated queries exercise the same cached field observation.
      expect(probe.frameMayFit(0, exact.bytes.length, exact.header)).toBe(true);
    },
  );

  it('does not borrow mandatory prefix fields from the reservoir', () => {
    const fixture = candidate(0, true, [0, 0, 0, 0], 511);
    expect(
      new Probe(fixture.bytes, true, fixture.bytes.length).frameMayFit(
        0,
        fixture.prefix - 1,
        fixture.header,
      ),
    ).toBe(false);
  });

  it('distinguishes unavailable probe bytes from a known incomplete EOF prefix', () => {
    const fixture = candidate(0, true, [0, 0, 0, 0]);
    const prefix = fixture.bytes.subarray(0, 4);
    expect(new Probe(prefix, false, 100).frameMayFit(0, 100, fixture.header)).toBe(true);
    expect(new Probe(prefix, true, 4).frameMayFit(0, 100, fixture.header)).toBe(false);
  });
});

describe('spectral-pair bounds for proposed new sequence evidence', () => {
  const variants = [0, 1, 2, 3].flatMap((mode) =>
    [false, true].flatMap((crc) =>
      [false, true].flatMap((switched) =>
        Array.from({ length: mode === 3 ? 2 : 4 }, (_, record) => ({
          mode,
          crc,
          switched,
          record,
        })),
      ),
    ),
  );
  it.each(variants)(
    'checks 288 versus 289 pairs in mode=$mode CRC=$crc switch=$switched record=$record',
    ({ mode, crc, switched, record }) => {
      for (const pairs of [288, 289, 511]) {
        const fixture = candidate(mode, crc, mode === 3 ? [0, 0] : [0, 0, 0, 0], 0, switched);
        const side = (4 + (crc ? 2 : 0)) * 8;
        writeBits(fixture.bytes, side + (mode === 3 ? 18 : 20) + record * 59 + 12, 9, pairs);
        const probe = new Probe(fixture.bytes, true, fixture.bytes.length);
        // This checks the field's domain, not Huffman validity of this zero-bit fixture.
        expect(probe.frameMayFit(0, fixture.bytes.length, fixture.header)).toBe(pairs === 288);
      }
    },
  );
});
