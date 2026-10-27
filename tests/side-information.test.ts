import { describe, expect, it } from 'vitest';
import { decodeFrameHeader } from '../src/mp3/frame-header.js';
import { minimumFrameDataSpan } from '../src/mp3/side-information.js';

function writeBits(bytes: Uint8Array, offset: number, width: number, value: number): void {
  for (let index = 0; index < width; index++) {
    const bit = offset + index;
    const mask = 1 << (7 - (bit & 7));
    bytes[bit >> 3] = (bytes[bit >> 3]! & ~mask) | ((value >> (width - index - 1)) & 1 ? mask : 0);
  }
}

function fixture(mode = 3, crc = false, start = 0) {
  const bytes = new Uint8Array(start + 256);
  bytes.set([255, crc ? 250 : 251, 4, mode << 6], start);
  const header = decodeFrameHeader(bytes.subarray(start, start + 4));
  if (header.kind !== 'free-format') throw new Error('Invalid independent test header');
  const side = (start + 4 + (crc ? 2 : 0)) * 8;
  const channels = mode === 3 ? 1 : 2;
  const records = Array.from(
    { length: channels * 2 },
    (_, i) => side + (mode === 3 ? 18 : 20) + i * 59,
  );
  return {
    bytes,
    header,
    side,
    records,
    prefix: 4 + (crc ? 2 : 0) + (mode === 3 ? 17 : 32),
    start,
  };
}

function span(input: ReturnType<typeof fixture>) {
  return minimumFrameDataSpan(input.bytes, input.start, input.header);
}

const layouts = [0, 1, 2, 3].flatMap((mode) => [false, true].map((crc) => ({ mode, crc })));

describe('necessary side-information contradictions, not full audio validation', () => {
  it.each(layouts)(
    'reads every record at its correct prefix: mode=$mode CRC=$crc',
    ({ mode, crc }) => {
      const input = fixture(mode, crc, 11);
      expect(span(input)).toBe(input.prefix);
      for (const record of input.records) {
        writeBits(input.bytes, record + 33, 1, 1);
        expect(span(input)).toBe(Infinity); // Transmitted switched block type zero is reserved.
        for (const type of [1, 2, 3]) {
          writeBits(input.bytes, record + 34, 2, type);
          expect(span(input)).toBe(input.prefix);
        }
        writeBits(input.bytes, record + 33, 3, 0);
      }
    },
  );

  it.each([false, true])('only rejects a necessarily used first table, switched=%s', (switched) => {
    for (const table of [0, 1, 3, 4, 5, 13, 14, 15, 31]) {
      const input = fixture();
      const record = input.records[0]!;
      if (switched) writeBits(input.bytes, record + 33, 3, 6); // flag=1, type=2.
      writeBits(input.bytes, record + (switched ? 37 : 34), 5, table);
      expect(span(input)).toBe(input.prefix); // No pairs: table selection is unused.
      writeBits(input.bytes, record + 12, 9, 1);
      expect(span(input)).toBe(table === 4 || table === 14 ? Infinity : input.prefix);
    }
  });

  it.each([16, 17, 18, 19, 20, 21, 22, 23])(
    'keeps unswitched table-select %i bits separate from short-block flags',
    (table) => {
      const input = fixture();
      for (const record of input.records) {
        // window_switching_flag remains zero. These are table_select[0]
        // bits, not a transmitted block_type=2 or mixed_block_flag.
        writeBits(input.bytes, record + 34, 5, table);
        writeBits(input.bytes, record + 29, 4, 15);
        writeBits(input.bytes, record, 12, 74);
      }
      // Two long granules, no scfsi reuse: (6+5)*4 + (5+5)*3 = 74 bits each.
      expect(span(input)).toBe(input.prefix + Math.ceil((2 * 74) / 8));
    },
  );

  it.each(layouts)(
    'never reads main/ancillary bytes as an extra side record: mode=$mode CRC=$crc',
    ({ mode, crc }) => {
      const input = fixture(mode, crc, 11);
      // Exactly two granules per channel occupy the fixed 17/32-byte side
      // information. With all lengths zero, every following byte is ancillary.
      input.bytes.fill(255, input.start + input.prefix);
      expect(span(input)).toBe(input.prefix);
    },
  );

  it('does not reject later undefined table fields without proving their region is used', () => {
    const input = fixture();
    const record = input.records[0]!;
    writeBits(input.bytes, record + 12, 9, 1);
    writeBits(input.bytes, record + 39, 5, 4);
    writeBits(input.bytes, record + 44, 5, 14);
    expect(span(input)).toBe(input.prefix);
  });

  it('retains the pair bound and grants claimed reservoir bytes, not mandatory prefix bytes', () => {
    const input = fixture();
    const record = input.records[0]!;
    writeBits(input.bytes, record + 12, 9, 288);
    expect(span(input)).toBe(input.prefix);
    writeBits(input.bytes, record + 12, 9, 289);
    expect(span(input)).toBe(Infinity);
    writeBits(input.bytes, record + 12, 9, 0);
    writeBits(input.bytes, input.side, 9, 511);
    expect(span(input)).toBe(input.prefix - 511);
    expect(
      minimumFrameDataSpan(input.bytes.subarray(0, input.prefix - 1), 0, input.header),
    ).toBeUndefined();
    expect(minimumFrameDataSpan(input.bytes.subarray(0, input.prefix), 0, input.header)).toBe(
      input.prefix - 511,
    );
  });
});

// Independent counts from the MPEG-1 transmitted scalefactor group sizes and
// the published slen table, not an invocation of a production field helper.
const scaleCases = [
  {
    name: 'long',
    switched: 0,
    counts: [0, 10, 20, 30, 33, 21, 31, 41, 32, 42, 52, 43, 53, 63, 64, 74],
  },
  {
    name: 'short',
    switched: 12,
    counts: [0, 18, 36, 54, 54, 36, 54, 72, 54, 72, 90, 72, 90, 108, 108, 126],
  },
  {
    name: 'mixed',
    switched: 13,
    counts: [0, 18, 36, 54, 51, 35, 53, 71, 52, 70, 88, 69, 87, 105, 104, 122],
  },
];

describe.each(scaleCases)('$name scalefactor bit budgets', ({ switched, counts }) => {
  it.each(counts.map((required, compression) => ({ required, compression })))(
    'accepts exactly $required bits but not one fewer for compression $compression',
    ({ required, compression }) => {
      const input = fixture();
      for (const record of input.records) {
        writeBits(input.bytes, record + 29, 4, compression);
        writeBits(input.bytes, record + 33, 4, switched);
        writeBits(input.bytes, record, 12, required);
      }
      expect(span(input)).toBe(input.prefix + Math.ceil((required * 2) / 8));
      if (required > 0) {
        writeBits(input.bytes, input.records[1]!, 12, required - 1);
        expect(span(input)).toBe(Infinity);
      }
    },
  );
});

describe('second-granule scalefactor reuse is channel-specific and conservative', () => {
  it.each([0, 1, 2, 3])('handles all scfsi bitmasks independently, mode=%i', (mode) => {
    const channels = mode === 3 ? 1 : 2;
    // With compression=15, the four groups need 24,20,15,15 bits.
    const omitted = [0, 15, 15, 30, 20, 35, 35, 50, 24, 39, 39, 54, 44, 59, 59, 74];
    for (let mask = 0; mask < 16; mask++) {
      for (let channel = 0; channel < channels; channel++) {
        const input = fixture(mode);
        const record = input.records[channels + channel]!;
        const required = 74 - omitted[mask]!;
        writeBits(input.bytes, record + 29, 4, 15);
        writeBits(input.bytes, input.side + (mode === 3 ? 14 : 12) + channel * 4, 4, mask);
        writeBits(input.bytes, record, 12, required);
        expect(span(input)).toBe(input.prefix + Math.ceil(required / 8));
        if (required > 0) {
          writeBits(input.bytes, record, 12, required - 1);
          expect(span(input)).toBe(Infinity);
        }
      }
    }
  });

  it.each([0, 1, 3])(
    'grants long-block reuse for block type %i without certifying the previous granule',
    (type) => {
      const input = fixture();
      writeBits(input.bytes, input.side + 14, 4, 15);
      const first = input.records[0]!;
      const second = input.records[1]!;
      writeBits(input.bytes, second + 29, 4, 15);
      if (type !== 0) writeBits(input.bytes, second + 33, 3, 4 + type);
      expect(span(input)).toBe(input.prefix);
      writeBits(input.bytes, first + 29, 4, 15);
      expect(span(input)).toBe(Infinity); // scfsi never omits first-granule values.
    },
  );

  it('never omits short or mixed block scalefactors due to scfsi flags', () => {
    for (const switched of [12, 13]) {
      const input = fixture();
      writeBits(input.bytes, input.side + 14, 4, 15);
      const record = input.records[1]!;
      writeBits(input.bytes, record + 29, 4, 15);
      writeBits(input.bytes, record + 33, 4, switched);
      expect(span(input)).toBe(Infinity);
    }
  });
});
