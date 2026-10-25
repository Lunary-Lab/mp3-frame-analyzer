import type { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { decodeFrameHeader, type FreeFormatFrameHeader } from './frame-header.js';

/**
 * Free-format MPEG-1 Layer III uses bitrate index zero and a fixed base length
 * plus each frame's padding bit. LAME supports up to 640 kbps: at 32 kHz the
 * largest frame is 2,881 bytes. Read ahead only once (three frame positions).
 */
export const MAX_FREE_FORMAT_FRAME_BYTES = 2_881;
const MIN_FREE_FORMAT_FRAME_BYTES = 24;
const MAX_PROBE_BYTES = MAX_FREE_FORMAT_FRAME_BYTES * 3 + 4;

/** The padding bit of a free-format header at `offset` with the stream's sample rate, if any. */
function paddingAt(window: Uint8Array, offset: number, sampleRateIndex: number): 0 | 1 | undefined {
  if (offset + 4 > window.length) return undefined;
  const header = decodeFrameHeader(window.subarray(offset, offset + 4));
  return header.kind === 'free-format' && header.sampleRateIndex === sampleRateIndex
    ? header.padding
    : undefined;
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
export async function inferFreeFormatBaseLength(
  reader: AsyncByteReader,
  first: FreeFormatFrameHeader,
): Promise<number> {
  const start = reader.offset;
  await reader.has(MAX_PROBE_BYTES);
  const window = reader.peek(Math.min(reader.bufferedLength, MAX_PROBE_BYTES));
  let bestBase = 0;
  let bestMatches = 0;
  let tied = false;
  for (let second = MIN_FREE_FORMAT_FRAME_BYTES; second <= MAX_FREE_FORMAT_FRAME_BYTES; second++) {
    const candidate = measureCandidate(window, first, second);
    if (candidate === undefined) continue;
    const { base, matches } = candidate;
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

/** Validate one possible span and measure its complete chain within the bounded probe. */
function measureCandidate(
  window: Uint8Array,
  first: FreeFormatFrameHeader,
  second: number,
): { base: number; matches: number } | undefined {
  const { sampleRateIndex } = first;
  if (paddingAt(window, second, sampleRateIndex) === undefined) return undefined;
  const base = second - first.padding;
  if (base < MIN_FREE_FORMAT_FRAME_BYTES || base > MAX_FREE_FORMAT_FRAME_BYTES - 1)
    return undefined;
  let matches = 1;
  let position = 0;
  let padding = first.padding;
  for (;;) {
    const next = position + base + padding;
    const nextPadding = paddingAt(window, next, sampleRateIndex);
    if (nextPadding === undefined) break;
    position = next;
    padding = nextPadding;
    matches++;
  }
  if (matches < 3) return undefined;
  return { base, matches };
}
