import fc from 'fast-check';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, frame, mp3 } from './helpers/mp3-fixtures.js';

it('property: arbitrary valid VBR frames count identically across arbitrary stream chunking', async () => {
  const caseArb = fc.record({
    frames: fc.array(
      fc.record({
        bitrateIndex: fc.integer({ min: 1, max: 14 }),
        sampleRateIndex: fc.integer({ min: 0, max: 2 }),
        padding: fc.constantFrom(0 as const, 1 as const),
        seed: fc.integer({ min: 0, max: 255 }),
      }),
      { minLength: 1, maxLength: 40 },
    ),
    chunks: fc.array(fc.integer({ min: 1, max: 8192 }), { minLength: 1, maxLength: 25 }),
  });

  await fc.assert(
    fc.asyncProperty(caseArb, async ({ frames, chunks: chunkSizes }) => {
      const bytes = mp3(frames.map((spec) => frame(spec)));
      const actual = await countMp3Frames(chunks(bytes, chunkSizes));
      expect(actual).toBe(frames.length);
    }),
    { numRuns: 160 },
  );
});

it('property: arbitrary frame payloads do not affect frame traversal', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 100 }),
      async (seeds) => {
        const bytes = mp3(seeds.map((seed) => frame({ seed })));
        expect(await countMp3Frames(chunks(bytes, [4, 3, 7, 99]))).toBe(seeds.length);
      },
    ),
    { numRuns: 100 },
  );
});
