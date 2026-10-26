import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// This checked-in FFmpeg fixture has 51 frames and no Xing frame. Strip its
// known 44-byte ID3 tag once, then concatenate complete encoded audio segments.
// Pinning the fixture prevents a later edit from silently changing the oracle.
const fixture = readFileSync(new URL('../tests/fixtures/no-xing.mp3', import.meta.url));
assert.equal(
  createHash('sha256').update(fixture).digest('hex'),
  'd1b03e9537245dcf338fc149bcaf3448f62b5bcd2fc0a41ab8f7ad14210439a3',
  'Update the performance fixture oracle deliberately if the fixture changes',
);
const audio = fixture.subarray(44);
export const FRAMES_PER_SEGMENT = 51;
export const BYTES_PER_SEGMENT = audio.length;
export const CHUNK_BYTES = 64 * 1024;

/** Fresh chunk backing stores avoid a buffer proportional to the repeated stream. */
export async function* audioChunks(repetitions, observe = () => {}) {
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
  const length = repetitions * audio.length;
  assert.ok(Number.isSafeInteger(length));
  let emitted = 0;
  while (emitted < length) {
    const chunk = new Uint8Array(Math.min(CHUNK_BYTES, length - emitted));
    let written = 0;
    while (written < chunk.length) {
      const segmentOffset = (emitted + written) % audio.length;
      const take = Math.min(audio.length - segmentOffset, chunk.length - written);
      chunk.set(audio.subarray(segmentOffset, segmentOffset + take), written);
      written += take;
    }
    emitted += chunk.length;
    observe();
    yield chunk;
  }
}

export function repetitionsForMiB(targetMiB) {
  assert.ok(Number.isFinite(targetMiB) && targetMiB > 0 && targetMiB <= 128);
  return Math.ceil((targetMiB * 1024 * 1024) / BYTES_PER_SEGMENT);
}
