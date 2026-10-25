import { createStructuredMp3 } from './create-structured.mjs';
import { outcome } from './oracles.mjs';

/** Structured, independent count oracle: wrong positive counts are findings. */
export async function fuzz(data) {
  const { bytes, expectedCount, expectedAudioFrameCount } = createStructuredMp3(data);
  const sizes = [1, 7, 127, 4096];
  const size = sizes[data.length ? data[0] % sizes.length : 0];
  const physical = await outcome(bytes, size);
  if (physical.kind !== 'success' || physical.count !== expectedCount) {
    throw new Error(
      `Valid MPEG-1 Layer III structure: expected ${expectedCount} frames, got ${JSON.stringify(physical)}`,
    );
  }
  // The generator knows whether it wrote a recognized initial encoder frame.
  const audio = await outcome(bytes, size, { includeVbrHeaderFrame: false });
  if (audio.kind !== 'success' || audio.count !== expectedAudioFrameCount) {
    throw new Error(
      `Excluding the initial encoder frame: expected ${expectedAudioFrameCount} frames, got ${JSON.stringify(audio)}`,
    );
  }
}
