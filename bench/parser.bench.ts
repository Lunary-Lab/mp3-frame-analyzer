import { bench, describe } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, frame, mp3 } from '../tests/helpers/mp3-fixtures.js';

const cbr = mp3(Array.from({ length: 5_000 }, () => frame()));
const vbr = mp3(
  Array.from({ length: 5_000 }, (_, i) => frame({ bitrateIndex: 1 + (i % 14), padding: (i % 2) as 0 | 1 })),
);

describe('MP3 parser throughput (~2 MiB samples)', () => {
  bench('CBR / 64 KiB chunks', async () => {
    await countMp3Frames(chunks(cbr, [64 * 1024]));
  });

  bench('VBR / variable chunk boundaries', async () => {
    await countMp3Frames(chunks(vbr, [7, 4096, 512, 16384]));
  });
});
