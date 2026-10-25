import type { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { decodeFrameHeader, type FreeFormatFrameHeader } from './frame-header.js';
import { hasPossibleMetadataPrefix, probeMetadata } from './id3.js';

/** LAME's interoperability ceiling, not an ISO maximum or a decoded-audio guarantee. */
export const MAX_FREE_FORMAT_FRAME_BYTES = 2_881;
const MIN_FREE_FORMAT_FRAME_BYTES = 24;
const MAX_PROBE_BYTES = MAX_FREE_FORMAT_FRAME_BYTES * 3 + 4;

function headerAt(
  window: Uint8Array,
  offset: number,
  sampleRateIndex: number,
): FreeFormatFrameHeader | undefined {
  if (offset + 4 > window.length) return undefined;
  const header = decodeFrameHeader(window.subarray(offset, offset + 4));
  return header.kind === 'free-format' && header.sampleRateIndex === sampleRateIndex
    ? header
    : undefined;
}

interface Candidate {
  readonly base: number;
  readonly matches: number;
  readonly anchored: boolean;
  readonly metadataMatches: number;
  readonly frames: readonly { start: number; end: number; header: FreeFormatFrameHeader }[];
}

/** Follow one fixed span; metadata is inspected only at that span's predicted boundaries. */
function followCandidate(
  window: Uint8Array,
  first: FreeFormatFrameHeader,
  base: number,
  ended: boolean,
): Candidate {
  let position = 0;
  let header: FreeFormatFrameHeader | undefined = first;
  let anchored = false;
  let metadataMatches = 0;
  const frames: { start: number; end: number; header: FreeFormatFrameHeader }[] = [];
  while (header !== undefined) {
    const end = position + base + header.padding;
    frames.push({ start: position, end, header });
    if (end > window.length) break;
    const metadata = probeMetadata(window, end);
    if (metadata === undefined) break;
    metadataMatches += metadata.tags;
    if (metadata.tags > 0) anchored = true;
    if (metadata.offset === window.length) {
      anchored = ended ? metadata.canEnd : anchored;
      break;
    }
    position = metadata.offset;
    // A partial header remains at ID3; a larger validated envelope ends
    // beyond the probe. headerAt stops either chain; the streaming skipper
    // later consumes the body and checks its footer.
    header = headerAt(window, position, first.sampleRateIndex);
  }
  return { base, matches: frames.length, anchored, metadataMatches, frames };
}

/**
 * With only one/two headers, do not swallow another compatible header as
 * payload, swallow a plausible metadata prefix, or select a frame too small
 * for its mandatory prefix. This is a
 * conservative ambiguity check, not compressed-audio or CRC validation.
 */
function shortCandidateIsUnambiguous(window: Uint8Array, candidate: Candidate): boolean {
  for (const { start, end, header } of candidate.frames) {
    const minimum = 4 + (header.hasCrc ? 2 : 0) + (header.mono ? 17 : 32);
    if (end - start < minimum) return false;
    for (let offset = start + 4; offset + 3 <= end; offset++) {
      if (
        (offset + 4 <= end && headerAt(window, offset, header.sampleRateIndex) !== undefined) ||
        hasPossibleMetadataPrefix(window.subarray(offset))
      )
        return false;
    }
  }
  return true;
}

/**
 * Infer a fixed unpadded span in one bounded probe. Prefer the unique longest
 * compatible chain (at least three headers). For shorter streams require a
 * complete EOF closure or a validated ID3v2 boundary, no unexplained payload
 * syncs, and a unique best candidate. Equal evidence rejects rather than breaking ties arbitrarily.
 * EOF/metadata anchoring is project structural policy: it cannot distinguish
 * every truncated free-format frame from a shorter complete one. No bitrate,
 * CRC, ancillary-data completeness or audio decoding is established here.
 */
export async function inferFreeFormatBaseLength(
  reader: AsyncByteReader,
  first: FreeFormatFrameHeader,
): Promise<number> {
  const start = reader.offset;
  const ended = !(await reader.has(MAX_PROBE_BYTES));
  const window = reader.peek(Math.min(reader.bufferedLength, MAX_PROBE_BYTES));
  let bestBase = 0;
  let bestMatches = 0;
  let bestMetadata = 0;
  let tied = false;
  for (let base = MIN_FREE_FORMAT_FRAME_BYTES; base < MAX_FREE_FORMAT_FRAME_BYTES; base++) {
    const candidate = followCandidate(window, first, base, ended);
    if (
      candidate.matches < 3 &&
      (!candidate.anchored || !shortCandidateIsUnambiguous(window, candidate))
    )
      continue;
    const strength = compareCandidateEvidence(candidate, bestMatches, bestMetadata);
    if (strength > 0) {
      bestBase = base;
      bestMatches = candidate.matches;
      bestMetadata = candidate.metadataMatches;
      tied = false;
    } else if (strength === 0) {
      tied = true;
    }
  }
  if (bestMatches === 0 || tied) {
    throw new Mp3ParseError(
      'unsupported-format',
      start,
      'Cannot infer a unique free-format MPEG frame size from consecutive headers',
    );
  }
  return bestBase;
}

/** Lexicographic project ranking: header-chain length first, metadata anchors second. */
function compareCandidateEvidence(
  candidate: Candidate,
  bestMatches: number,
  bestMetadata: number,
): number {
  const byHeaders = candidate.matches - bestMatches;
  return byHeaders === 0 ? candidate.metadataMatches - bestMetadata : byHeaders;
}
