import { describe, test } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, frame, mp3 } from '../tests/helpers/mp3-fixtures.js';

const cbr = mp3(Array.from({ length: 5_000 }, () => frame()));
const vbr = mp3(
  Array.from({ length: 5_000 }, (_, i) =>
    frame({ bitrateIndex: 1 + (i % 14), padding: (i % 2) as 0 | 1 }),
  ),
);

describe('MP3 parser throughput (~2 MiB samples)', () => {
  test('CBR / 64 KiB chunks', async ({ bench }) => {
    await bench('count 5,000 CBR frames', () => countMp3Frames(chunks(cbr, [64 * 1024]))).run();
  });

  test('VBR / variable chunk boundaries', async ({ bench }) => {
    await bench('count 5,000 VBR frames', () =>
      countMp3Frames(chunks(vbr, [7, 4096, 512, 16384])),
    ).run();
  });
});
