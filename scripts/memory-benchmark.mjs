import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIB = 1024 * 1024;
const worker = fileURLToPath(new URL('./memory-benchmark-worker.mjs', import.meta.url));
// Separate processes prevent a small run's GC state from biasing the large run.
const sizesMiB = [8, 32, 128];
const results = sizesMiB.map((targetMiB) => {
  const child = spawnSync(process.execPath, ['--expose-gc', worker, String(targetMiB)], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: MIB,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `Memory worker failed: ${child.stderr || child.stdout}`);
  return JSON.parse(child.stdout);
});

// These tolerate GC/JIT and shared-runner variation. A retained 128 MiB input
// still exceeds them. Throughput and event-loop measurements are informational.
const limitsMiB = { rss: 80, heapUsed: 32, external: 48, arrayBuffers: 48 };
const scalingLimitsMiB = { rss: 48, heapUsed: 24, external: 40, arrayBuffers: 40 };
const smallest = results[0];
const largest = results[results.length - 1];
const additionalGrowthBytes = Object.fromEntries(
  Object.keys(scalingLimitsMiB).map((metric) => [
    metric,
    largest.peakGrowthBytes[metric] - smallest.peakGrowthBytes[metric],
  ]),
);

console.log(
  JSON.stringify(
    {
      kind: 'parser-memory-scaling',
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      source: 'Distinct 64 KiB chunks of repeated real MPEG-1 Layer III audio frames',
      limitsMiB,
      scalingLimitsMiB,
      inputSizeRatio: largest.bytesProcessed / smallest.bytesProcessed,
      additionalGrowthBytes,
      results,
    },
    null,
    2,
  ),
);

for (const result of results) {
  assert.equal(result.frames, result.expectedFrames, 'Frame count changed during memory test');
  for (const [metric, limitMiB] of Object.entries(limitsMiB)) {
    assert.ok(
      result.peakGrowthBytes[metric] <= limitMiB * MIB,
      `${metric} grew more than ${limitMiB} MiB for ${result.bytesProcessed} bytes`,
    );
  }
}
for (const [metric, limitMiB] of Object.entries(scalingLimitsMiB)) {
  assert.ok(
    additionalGrowthBytes[metric] <= limitMiB * MIB,
    `${metric} growth scales with total input size`,
  );
}
