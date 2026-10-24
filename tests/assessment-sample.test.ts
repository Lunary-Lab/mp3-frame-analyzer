import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';

const sample = process.env['ASSESSMENT_SAMPLE_PATH'];
it.skipIf(!sample)('correctly counts the original assessment sample', async () => {
  const bytes = await readFile(sample!);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3',
  );
  for (const highWaterMark of [127, 4096, 65536]) {
    await expect(countMp3Frames(createReadStream(sample!, { highWaterMark }))).resolves.toBe(6090);
    await expect(
      countMp3Frames(createReadStream(sample!, { highWaterMark }), {
        includeVbrHeaderFrame: false,
      }),
    ).resolves.toBe(6089);
  }
});
