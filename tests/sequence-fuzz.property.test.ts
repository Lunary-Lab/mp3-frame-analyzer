import fc from 'fast-check';
import { expect, it } from 'vitest';
import { createSequenceMp3 } from '../fuzz/create-sequences.mjs';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { Mp3ParseError } from '../src/mp3/errors.js';
import { chunks } from './helpers/mp3-fixtures.js';

async function result(bytes: Uint8Array, sizes: number[], include = true) {
  try {
    return {
      count: await countMp3Frames(chunks(bytes, sizes), { includeVbrHeaderFrame: include }),
    };
  } catch (error) {
    if (!(error instanceof Mp3ParseError)) throw error;
    return { kind: error.kind, offset: error.offset, message: error.message };
  }
}

async function checkSequenceCase(data: Uint8Array, partition: number[]) {
  const fixture = createSequenceMp3(data);
  expect(fixture.bytes.length).toBeLessThanOrEqual(81_000);
  const whole = await result(fixture.bytes, [fixture.bytes.length]);
  expect(await result(fixture.bytes, partition)).toEqual(whole);
  const excluded = await result(fixture.bytes, [fixture.bytes.length], false);
  expect(await result(fixture.bytes, partition, false)).toEqual(excluded);
  expect(await result(fixture.bytes, [1], false)).toEqual(excluded);
  if (fixture.expectation.kind === 'structural' && 'count' in whole && 'count' in excluded) {
    expect(whole.count - excluded.count).toBeGreaterThanOrEqual(0);
    expect(whole.count - excluded.count).toBeLessThanOrEqual(1);
  } else {
    expect(excluded).toEqual(whole);
  }
  if (fixture.expectation.kind === 'count') {
    expect(whole).toEqual({ count: fixture.expectation.count });
  } else if (fixture.expectation.kind === 'ambiguous') {
    expect(whole).toMatchObject({
      kind: 'unsupported-format',
      message: 'Ambiguous free-format MPEG frame layout',
    });
  } else if ('count' in whole) {
    expect(whole.count).toBeGreaterThan(0);
    expect(whole.count * 21).toBeLessThanOrEqual(fixture.bytes.length);
  }
}

it('property: generated successive configurations retain exact anchored counts or explicit uncertainty', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 0, maxLength: 160 }),
      fc.array(fc.integer({ min: 1, max: 8192 }), { minLength: 1, maxLength: 8 }),
      async (data, partition) => {
        await checkSequenceCase(data, partition);
      },
    ),
    { numRuns: 250, seed: 260126 },
  );
});

it.each(['Xing', 'Info', 'VBRI'])(
  'accepts arbitrary sequence payload that legitimately starts with %s metadata',
  async (signature) => {
    const data = new Uint8Array(160);
    data[0] = 1; // Arbitrary payload domain; two independently sized indexed frames.
    data.set(Buffer.from(signature), 36);
    if (signature === 'VBRI') {
      data[41] = 1; // Version 1.
      data[55] = 1; // One table entry.
      data[59] = 1; // One byte per table entry.
    }
    const fixture = createSequenceMp3(data);
    expect(await result(fixture.bytes, [fixture.bytes.length])).toEqual({ count: 2 });
    expect(await result(fixture.bytes, [1], false)).toEqual({ count: 1 });
    await checkSequenceCase(data, [1]);
  },
);
