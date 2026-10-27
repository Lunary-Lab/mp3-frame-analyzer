import {
  array,
  assert,
  asyncProperty,
  boolean,
  constantFrom,
  integer,
  record,
  uint8Array,
  type Parameters,
} from 'fast-check';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { Mp3ParseError } from '../../src/mp3/errors.js';
import { chunks, frame, id3v1, id3v2, mp3 } from '../helpers/mp3-fixtures.js';

const frameOptions = record({
  bitrateIndex: integer({ min: 1, max: 14 }),
  sampleRateIndex: integer({ min: 0, max: 2 }),
  padding: constantFrom(0 as const, 1 as const),
  hasCrc: boolean(),
  seed: integer({ min: 0, max: 255 }),
});

function options(runs: number): Parameters<unknown> {
  const seed = process.env['PROPERTY_SEED'];
  const path = process.env['PROPERTY_PATH'];
  return {
    numRuns: runs,
    ...(seed === undefined ? {} : { seed: Number(seed) }),
    ...(path === undefined ? {} : { path }),
  };
}

const partition = array(integer({ min: 1, max: 8192 }), {
  minLength: 1,
  maxLength: 15,
});

it('property: VBR frame counts are invariant across chunk boundaries', async () => {
  const cases = record({
    frames: array(frameOptions, { minLength: 1, maxLength: 40 }),
    chunkSizes: partition,
  });
  await assert(
    asyncProperty(cases, async ({ frames, chunkSizes }) => {
      const bytes = mp3(frames.map((spec) => frame(spec)));
      expect(await countMp3Frames(chunks(bytes, chunkSizes))).toBe(frames.length);
    }),
    options(180),
  );
});

it('property: arbitrary payload bytes including sync markers never introduce extra frames', async () => {
  await assert(
    asyncProperty(
      array(uint8Array({ minLength: 1, maxLength: 256 }), {
        minLength: 1,
        maxLength: 40,
      }),
      async (payloads) => {
        const bytes = mp3(
          payloads.map((payload) => {
            const bytes = frame();
            bytes.set(payload, 4);
            return bytes;
          }),
        );
        expect(await countMp3Frames(chunks(bytes, [4, 3, 7, 99]))).toBe(payloads.length);
      },
    ),
    options(120),
  );
});

it('property: concatenating independently generated frame sequences adds their counts', async () => {
  await assert(
    asyncProperty(
      array(frameOptions, { minLength: 1, maxLength: 30 }),
      array(frameOptions, { minLength: 1, maxLength: 30 }),
      partition,
      async (left, right, sizes) => {
        const bytes = mp3([...left, ...right].map((spec) => frame(spec)));
        expect(await countMp3Frames(chunks(bytes, sizes))).toBe(left.length + right.length);
      },
    ),
    options(130),
  );
});

it('property: leading and appended ID3 metadata never change counts', async () => {
  await assert(
    asyncProperty(
      array(frameOptions, { minLength: 1, maxLength: 20 }),
      uint8Array({ minLength: 0, maxLength: 512 }),
      constantFrom(2 as const, 3 as const, 4 as const),
      boolean(),
      boolean(),
      boolean(),
      partition,
      async (frames, body, version, withFooter, withV1, withAppendedTag, sizes) => {
        const tag = id3v2(body, version, version === 4 && withFooter);
        const tail = Buffer.concat([
          ...(withAppendedTag ? [id3v2(body, 4, true)] : []),
          ...(withV1 ? [id3v1()] : []),
        ]);
        const bytes = mp3(
          frames.map((spec) => frame(spec)),
          tag,
          tail,
        );
        expect(await countMp3Frames(chunks(bytes, sizes))).toBe(frames.length);
      },
    ),
    options(150),
  );
});

it('property: truncating a final frame always yields a typed truncation error', async () => {
  await assert(
    asyncProperty(
      frameOptions,
      frameOptions,
      integer({ min: 1, max: 99 }),
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

it('property: representative invalid MPEG header fields are rejected', async () => {
  const modeArb = constantFrom(
    'unsupported-version',
    'unsupported-layer',
    'invalid-rate',
    'invalid-bitrate',
    'reserved-emphasis' as const,
  );
  await assert(
    asyncProperty(frameOptions, modeArb, async (spec, mode) => {
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
  await assert(
    asyncProperty(uint8Array({ minLength: 0, maxLength: 512 }), partition, async (bytes, sizes) => {
      expect(await outcome(bytes, sizes)).toEqual(await outcome(bytes, [1]));
    }),
    options(180),
  );
});
