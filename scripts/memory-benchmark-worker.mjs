import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { countMp3Frames } from '../dist/mp3/count-frames.js';
import {
  audioChunks,
  BYTES_PER_SEGMENT,
  CHUNK_BYTES,
  FRAMES_PER_SEGMENT,
  repetitionsForMiB,
} from './performance-fixture.mjs';

assert.equal(typeof global.gc, 'function', 'Run the memory worker with --expose-gc');
const repetitions = repetitionsForMiB(Number(process.argv[2]));
global.gc();
const baseline = process.memoryUsage();
const peaks = { ...baseline };
function observe() {
  const current = process.memoryUsage();
  for (const metric of Object.keys(current)) {
    peaks[metric] = Math.max(peaks[metric], current[metric]);
  }
}

let completed = false;
const started = performance.now();
// The source does not sleep or schedule yields. This observation measures when
// the parser actually lets a pending event-loop callback execute.
const immediate = new Promise((resolve) => {
  setImmediate(() => {
    resolve({ delayMs: performance.now() - started, beforeCompletion: !completed });
  });
});
const frames = await countMp3Frames(audioChunks(repetitions, observe));
const elapsedMs = performance.now() - started;
completed = true;
observe();
const firstImmediate = await immediate;
// maxRSS is the OS high-water mark in KiB, independent of sampling frequency.
const peakRssBytes = process.resourceUsage().maxRSS * 1024;
peaks.rss = Math.max(peaks.rss, peakRssBytes);
const peakGrowthBytes = Object.fromEntries(
  ['rss', 'heapUsed', 'external', 'arrayBuffers'].map((metric) => [
    metric,
    Math.max(0, peaks[metric] - baseline[metric]),
  ]),
);
global.gc();
const afterGc = process.memoryUsage();
const bytesProcessed = repetitions * BYTES_PER_SEGMENT;
console.log(
  JSON.stringify({
    bytesProcessed,
    chunkBytes: CHUNK_BYTES,
    frames,
    expectedFrames: repetitions * FRAMES_PER_SEGMENT,
    elapsedMs,
    throughputMiBps: bytesProcessed / (1024 * 1024) / (elapsedMs / 1000),
    baselineBytes: baseline,
    peakBytes: peaks,
    peakRssBytes,
    peakGrowthBytes,
    afterGcBytes: afterGc,
    firstImmediate,
  }),
);
