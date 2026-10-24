import fc from 'fast-check';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { Mp3ParseError } from '../src/mp3/errors.js';
import { chunks, frame, id3v1, id3v2, mp3 } from './helpers/mp3-fixtures.js';

const frameOptions = fc.record({
  bitrateIndex: fc.integer({ min: 1, max: 14 }),
  sampleRateIndex: fc.integer({ min: 0, max: 2 }),
  padding: fc.constantFrom(0 as const, 1 as const),
  hasCrc: fc.boolean(),
  seed: fc.integer({ min: 0, max: 255 }),
});

function options(runs: number): fc.Parameters<unknown> {
  const seed = process.env['PROPERTY_SEED'];
  const path = process.env['PROPERTY_PATH'];
  return {
    numRuns: runs,
    ...(seed === undefined ? {} : { seed: Number(seed) }),
    ...(path === undefined ? {} : { path }),
  };
}

const partition = fc.array(fc.integer({ min: 1, max: 8192 }), {
  minLength: 1,
  maxLength: 15,
});

it('property: VBR frame counts are invariant across chunk boundaries', async () => {
  const cases = fc.record({
    frames: fc.array(frameOptions, { minLength: 1, maxLength: 40 }),
    chunkSizes: partition,
  });
  await fc.assert(
    fc.asyncProperty(cases, async ({ frames, chunkSizes }) => {
      const bytes = mp3(frames.map((spec) => frame(spec)));
      expect(await countMp3Frames(chunks(bytes, chunkSizes))).toBe(frames.length);
    }),
    options(180),
  );
});

it('property: arbitrary payload bytes including sync markers never introduce extra frames', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 255 }), {
        minLength: 1,
        maxLength: 100,
      }),
      async (seeds) => {
        const bytes = mp3(seeds.map((seed) => frame({ seed })));
        expect(await countMp3Frames(chunks(bytes, [4, 3, 7, 99]))).toBe(seeds.length);
      },
    ),
    options(120),
  );
});

it('property: concatenating independently generated frame sequences adds their counts', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(frameOptions, { minLength: 1, maxLength: 30 }),
      fc.array(frameOptions, { minLength: 1, maxLength: 30 }),
      partition,
      async (left, right, sizes) => {
        const bytes = mp3([...left, ...right].map((spec) => frame(spec)));
        expect(await countMp3Frames(chunks(bytes, sizes))).toBe(left.length + right.length);
      },
    ),
    options(130),
  );
});

it('property: ID3 tag lengths, footers, and trailing ID3v1 never change counts', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(frameOptions, { minLength: 1, maxLength: 20 }),
      fc.uint8Array({ minLength: 0, maxLength: 512 }),
      fc.constantFrom(2 as const, 3 as const, 4 as const),
      fc.boolean(),
      fc.boolean(),
      partition,
      async (frames, body, version, withFooter, withV1, sizes) => {
        const tag = id3v2(body, version, version === 4 && withFooter);
        const bytes = mp3(
          frames.map((spec) => frame(spec)),
          tag,
          withV1 ? id3v1() : undefined,
        );
        expect(await countMp3Frames(chunks(bytes, sizes))).toBe(frames.length);
      },
    ),
    options(150),
  );
});

it('property: truncating a final frame always yields a typed truncation error', async () => {
  await fc.assert(
    fc.asyncProperty(
      frameOptions,
      frameOptions,
      fc.integer({ min: 1, max: 99 }),
      async (first, last, percentage) => {
        const initial = frame(first);
        const final = frame(last);
        const remaining = Math.max(1, Math.floor((final.length * percentage) / 100));
        const bytes = Buffer.concat([initial, final.subarray(0, remaining)]);
        await expect(countMp3Frames(chunks(bytes, [1, 3, 128]))).rejects.toMatchObject({
          kind: 'truncated-mp3',
        });
      },
    ),
    options(150),
  );
});

it('property: every forbidden MPEG header bit pattern is rejected', async () => {
  const modeArb = fc.constantFrom(
    'unsupported-version',
    'unsupported-layer',
    'invalid-rate',
    'invalid-bitrate',
    'reserved-emphasis' as const,
  );
  await fc.assert(
    fc.asyncProperty(frameOptions, modeArb, async (spec, mode) => {
      const bytes = frame(spec);
      switch (mode) {
        case 'unsupported-version':
          bytes[1] = (bytes[1]! & ~0x18) | 0x10;
          break;
        case 'unsupported-layer':
          bytes[1] = (bytes[1]! & ~0x06) | 0x04;
          break;
        case 'invalid-rate':
          bytes[2] = (bytes[2]! & ~0x0c) | 0x0c;
          break;
        case 'invalid-bitrate':
          bytes[2] = (bytes[2]! & ~0xf0) | 0xf0;
          break;
        case 'reserved-emphasis':
          bytes[3] = (bytes[3]! & ~3) | 2;
          break;
      }
      await expect(countMp3Frames(chunks(bytes, [1, 12, 67]))).rejects.toBeInstanceOf(
        Mp3ParseError,
      );
    }),
    options(150),
  );
});

it('property: parsing arbitrary byte streams is independent of chunk partitioning', async () => {
  const outcome = async (bytes: Uint8Array, sizes: readonly number[]) => {
    try {
      return {
        kind: 'count',
        value: await countMp3Frames(chunks(bytes, sizes)),
      };
    } catch (error) {
      if (!(error instanceof Mp3ParseError)) throw error;
      return { kind: error.kind, offset: error.offset };
    }
  };
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 0, maxLength: 512 }),
      partition,
      async (bytes, sizes) => {
        expect(await outcome(bytes, sizes)).toEqual(await outcome(bytes, [1]));
      },
    ),
    options(180),
  );
});
