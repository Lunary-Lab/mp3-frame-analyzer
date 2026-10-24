import { performance } from 'node:perf_hooks';
import { countMp3Frames } from '../dist/mp3/count-frames.js';

// Stream ~40 MiB without ever allocating a file-sized buffer.
const frame = new Uint8Array(417);
frame.set([0xff, 0xfb, 0x90, 0x00]);
const totalFrames = 100_000;

if (global.gc) global.gc();
const initial = process.memoryUsage().rss;
let peak = initial;
async function* source() {
  for (let i = 0; i < totalFrames; i++) {
    if (i % 1024 === 0) {
      peak = Math.max(peak, process.memoryUsage().rss);
      // Give the event loop a chance to process normal operational work.
      await new Promise((resolve) => setImmediate(resolve));
    }
    yield frame;
  }
}

const started = performance.now();
const counted = await countMp3Frames(source());
const seconds = (performance.now() - started) / 1000;
peak = Math.max(peak, process.memoryUsage().rss);
const mib = (totalFrames * frame.length) / (1024 * 1024);
const growth = (peak - initial) / (1024 * 1024);

console.log(
  JSON.stringify(
    {
      bytesProcessed: totalFrames * frame.length,
      frames: counted,
      seconds: Number(seconds.toFixed(3)),
      throughputMiBps: Number((mib / seconds).toFixed(1)),
      peakRssGrowthMiB: Number(growth.toFixed(1)),
      node: process.version,
    },
    null,
    2,
  ),
);

if (counted !== totalFrames || growth > 64) {
  console.error('Frame count mismatch or excessive RSS growth');
  process.exitCode = 1;
}
