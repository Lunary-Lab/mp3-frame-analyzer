import type { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { isFreeFormatHeader } from './frame-header.js';

/**
 * Free-format MPEG-1 Layer III uses bitrate index zero and a fixed base length
 * plus each frame's padding bit. LAME supports up to 640 kbps: at 32 kHz the
 * largest frame is 2,881 bytes. Read ahead only once (three frame positions).
 */
export const MAX_FREE_FORMAT_FRAME_BYTES = 2_881;
const MIN_FREE_FORMAT_FRAME_BYTES = 24;
const MAX_PROBE_BYTES = MAX_FREE_FORMAT_FRAME_BYTES * 3 + 4;

function compatible(bytes: Uint8Array, offset: number, sampleRateBits: number): boolean {
  return (
    offset + 4 <= bytes.length &&
    isFreeFormatHeader(bytes.subarray(offset, offset + 4)) &&
    (bytes[offset + 2]! & 0x0c) === sampleRateBits
  );
}

/**
 * Find the unique plausible fixed length, confirmed by several consecutive
 * headers. Ignore single payload syncs; ties fail closed instead of guessing.
 * Tiny streams with fewer than three identifiable headers are ambiguous.
 *
 * Each chain runs to the end of the probe window. Without padding variation,
 * multiples of the true span also land on frame boundaries, but they visit
 * fewer headers; capping chains would turn them into false ties.
 */
export async function inferFreeFormatBaseLength(reader: AsyncByteReader): Promise<number> {
  const start = reader.offset;
  await reader.has(MAX_PROBE_BYTES);
  const window = reader.peek(Math.min(reader.bufferedLength, MAX_PROBE_BYTES));
  const rateBits = window[2]! & 0x0c;
  const initialPadding = (window[2]! >>> 1) & 1;
  let bestBase = 0;
  let bestMatches = 0;
  let tied = false;
  for (let second = MIN_FREE_FORMAT_FRAME_BYTES; second <= MAX_FREE_FORMAT_FRAME_BYTES; second++) {
    if (!compatible(window, second, rateBits)) continue;
    const base = second - initialPadding;
    if (base < MIN_FREE_FORMAT_FRAME_BYTES || base > MAX_FREE_FORMAT_FRAME_BYTES - 1) continue;
    let matches = 1;
    let position = 0;
    for (;;) {
      const next = position + base + ((window[position + 2]! >>> 1) & 1);
      if (!compatible(window, next, rateBits)) break;
      position = next;
      matches++;
    }
    if (matches < 3) continue;
    if (matches > bestMatches) {
      bestBase = base;
      bestMatches = matches;
      tied = false;
    } else if (matches === bestMatches && base !== bestBase) {
      tied = true;
    }
  }
  if (bestMatches < 3 || tied) {
    throw new Mp3ParseError(
      'unsupported-format',
      start,
      'Cannot infer a unique free-format MPEG frame size from consecutive headers',
    );
  }
  return bestBase;
}
