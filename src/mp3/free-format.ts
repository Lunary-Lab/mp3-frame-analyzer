import { yieldToEventLoop } from './cooperative.js';
import type { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import type { FreeFormatFrameHeader } from './frame-header.js';
import {
  Probe,
  ClosedShortCandidates,
  type Candidate,
  type ProbeWork,
  type SuffixEvidence,
  type TargetHeader,
  type Metadata,
} from './free-format-probe.js';

// floor(144 * 320000 / sampleRate) for 44.1, 48 and 32 kHz, before padding.
// The inclusive endpoint interpretation is documented in the MPEG contract;
// extension-only rates must never contribute root or successor evidence.
const MAX_FREE_FORMAT_BASE_BYTES = [1_044, 960, 1_440] as const;
// ceil(144 * 320000 / sampleRate): at the integer 32/48 kHz endpoints
// another padding byte cannot belong to a fixed rate within the envelope.
export const MAX_FREE_FORMAT_PHYSICAL_BYTES = [1_045, 960, 1_440] as const;
// The smallest physical prefix is 21 bytes; one padding byte can make base 20 fit.
const MIN_FREE_FORMAT_FRAME_BYTES = 20;
// Preserve the fixed observation budget independently of candidate eligibility.
const MAX_PROBE_BYTES = 8_647;

interface Selection {
  readonly bestBase: number;
  readonly bestMatches: number;
  readonly tied: boolean;
}
/** Follow a fixed span; only its predicted boundaries can anchor a new configuration. */
function followCandidate(
  probe: Probe,
  start: number,
  first: FreeFormatFrameHeader,
  base: number,
): Candidate {
  let position = start;
  let header: FreeFormatFrameHeader | undefined = first;
  let anchored = false;
  let metadataMatches = 0;
  let transition = false;
  let closed = false;
  const frames: { start: number; end: number; header: FreeFormatFrameHeader }[] = [];
  while (header !== undefined) {
    probe.visitFrame();
    const end = position + base + header.padding;
    frames.push({ start: position, end, header });
    if (end > probe.window.length) break;
    const metadata = probe.boundary(end);
    if (metadata === undefined) break;
    metadataMatches += metadata.tags;
    if (metadata.tags > 0) anchored = true;
    if (metadata.offset === probe.window.length) {
      anchored = probe.ended ? metadata.canEnd : anchored;
      closed = probe.ended && metadata.canEnd;
      break;
    }
    position = metadata.offset;
    header = compatibleHeader(probe.headers.get(position), first);
    if (isSupportedTransition(probe, position, first)) {
      anchored = true;
      transition = true;
      closed = probe.suffixes.get(position)!.closed;
    }
  }
  return { base, matches: frames.length, anchored, metadataMatches, transition, closed, frames };
}

function compatibleHeader(
  next: TargetHeader | undefined,
  first: FreeFormatFrameHeader,
): FreeFormatFrameHeader | undefined {
  return next?.kind === 'free-format' && next.sampleRateIndex === first.sampleRateIndex
    ? next
    : undefined;
}

function isSupportedTransition(
  probe: Probe,
  offset: number,
  first: FreeFormatFrameHeader,
): boolean {
  const next = probe.headers.get(offset);
  return (
    next !== undefined &&
    next.sampleRateIndex !== first.sampleRateIndex &&
    probe.suffixes.get(offset)?.credible === true
  );
}

function candidateIsEligible(
  probe: Probe,
  candidate: Candidate,
  successorEvidenceOnly: boolean,
  shorts: ClosedShortCandidates,
): boolean {
  if (
    candidate.frames.some(
      (frame) =>
        frame.end - frame.start > MAX_FREE_FORMAT_PHYSICAL_BYTES[frame.header.sampleRateIndex]!,
    )
  )
    return false;
  // Physical eligibility precedes all evidence collection, including fallback.
  shorts.observe(candidate);
  if (candidate.matches < 3 && (!candidate.anchored || !probe.shortIsUnambiguous(candidate)))
    return false;
  if (
    (successorEvidenceOnly || candidate.transition) &&
    candidate.frames.some((frame) => !probe.frameMayFit(frame.start, frame.end, frame.header))
  )
    return false;
  return !(successorEvidenceOnly && probe.ended && !candidate.closed);
}

/**
 * Select within the existing same-configuration evidence policy. A supported
 * transition is not outvoted by a coarser span that hides the configuration:
 * different first spans with such evidence remain ambiguous.
 */
function* selectCandidate(
  probe: Probe,
  start: number,
  first: FreeFormatFrameHeader,
  successorEvidenceOnly = false,
): Generator<ProbeWork, Selection> {
  const selected = new RankedCandidates();
  const shorts = new ClosedShortCandidates(probe, first, !successorEvidenceOnly);
  const maximumBase = MAX_FREE_FORMAT_BASE_BYTES[first.sampleRateIndex]!;
  // A suffix whose prefix cannot fit even the largest candidate span cannot
  // contribute evidence. This also rejects impossible side fields once.
  if (
    successorEvidenceOnly &&
    !probe.frameMayFit(start, start + maximumBase + first.padding, first)
  ) {
    return selected.result();
  }
  const begin = probe.landmarkStart(start + first.padding + MIN_FREE_FORMAT_FRAME_BYTES);
  for (let index = begin; index < probe.landmarks.length; index++) {
    if (probe.shouldYield()) yield { ...probe.work };
    const base = probe.landmarks[index]! - start - first.padding;
    if (base > maximumBase) break;
    probe.visitCandidate();
    const candidate = followCandidate(probe, start, first, base);
    if (!candidateIsEligible(probe, candidate, successorEvidenceOnly, shorts)) continue;
    // Suffix consumers need existence, not ranking or path enumeration.
    if (successorEvidenceOnly)
      return { bestBase: base, bestMatches: candidate.matches, tied: false };
    selected.consider(candidate);
  }
  return selected.withShortFallback(shorts);
}

class RankedCandidates {
  private bestBase = 0;
  private bestMatches = 0;
  private bestMetadata = 0;
  private tied = false;
  private readonly transitions: number[] = [];

  withShortFallback(shorts: ClosedShortCandidates): Selection {
    // Preserve every existing successful selection, tie and >=3-header policy.
    // Only proved EOF closure can replace raw sync sightings with complete walks.
    // New suffix/changed-rate evidence retains its existing conservative policy.
    if (this.bestMatches === 0)
      for (const candidate of shorts.candidates()) this.consider(candidate);
    return this.result();
  }

  consider(candidate: Candidate): void {
    if (candidate.transition) this.transitions.push(candidate.base);
    const strength = compareCandidateEvidence(candidate, this.bestMatches, this.bestMetadata);
    if (strength > 0) {
      this.bestBase = candidate.base;
      this.bestMatches = candidate.matches;
      this.bestMetadata = candidate.metadataMatches;
      this.tied = false;
    } else if (strength === 0) {
      this.tied = true;
    }
  }

  result(): Selection {
    return {
      bestBase: this.bestBase,
      bestMatches: this.bestMatches,
      tied: this.tied || this.transitions.some((base) => base !== this.bestBase),
    };
  }
}

/** Preserve existing lexicographic same-configuration evidence. */
function compareCandidateEvidence(candidate: Candidate, matches: number, metadata: number): number {
  const byHeaders = candidate.matches - matches;
  return byHeaders === 0 ? candidate.metadataMatches - metadata : byHeaders;
}

/** A successor's existence is enough; ambiguity within it is not silently resolved. */
function indexedEvidence(
  probe: Probe,
  offset: number,
  header: Extract<TargetHeader, { kind: 'indexed' }>,
): SuffixEvidence {
  const end = offset + header.length;
  if (end > probe.window.length || !probe.frameMayFit(offset, end, header)) {
    return { credible: false, closed: false, indexedMatches: 0 };
  }
  const metadata = probe.boundary(end);
  if (metadata === undefined) return { credible: false, closed: false, indexedMatches: 1 };
  if (probe.ended && metadata.offset === probe.window.length && metadata.canEnd) {
    return { credible: true, closed: true, indexedMatches: 1 };
  }
  return indexedSuccessorEvidence(probe, metadata, header);
}

function mayFollowIndexed(header: TargetHeader, next: TargetHeader | undefined): boolean {
  return (
    next?.kind === 'indexed' ||
    (next?.kind === 'free-format' && next.sampleRateIndex !== header.sampleRateIndex)
  );
}

function hasOpenIndexedEvidence(
  tags: number,
  matches: number,
  allowed: boolean,
  suffix: SuffixEvidence | undefined,
): boolean {
  return tags > 0 || matches >= 3 || (allowed && suffix!.credible);
}

function indexedSuccessorEvidence(
  probe: Probe,
  metadata: Exclude<Metadata, undefined>,
  header: TargetHeader,
): SuffixEvidence {
  const next = probe.headers.get(metadata.offset);
  // Every supported successor is at a greater offset and was already
  // evaluated by the reverse dynamic program.
  const suffix = probe.suffixes.get(metadata.offset);
  const allowed = mayFollowIndexed(header, next);
  const matches = next?.kind === 'indexed' ? 1 + suffix!.indexedMatches : 1;
  const closed = allowed && suffix!.closed;
  const credible = probe.ended
    ? closed
    : hasOpenIndexedEvidence(metadata.tags, matches, allowed, suffix);
  return { credible, closed, indexedMatches: matches };
}

/**
 * Offset-increasing dynamic program on one fixed probe, evaluated in reverse.
 * Never enumerate paths, recurse, or give successor headers votes for a prior
 * configuration's free span. Metrics make worst-case work directly testable.
 */
export function* analyzeFreeFormatProbeSteps(
  window: Uint8Array,
  first: FreeFormatFrameHeader,
  ended: boolean,
  minimumStreamLength: number,
): Generator<ProbeWork, Selection & ProbeWork> {
  const probe = new Probe(window, ended, minimumStreamLength);
  const entries = [...probe.headers];
  if (entries.some(([, header]) => header.sampleRateIndex !== first.sampleRateIndex)) {
    for (let index = entries.length - 1; index > 0; index--) {
      if (probe.shouldYield()) yield { ...probe.work };
      const [offset, header] = entries[index]!;
      if (header.kind === 'free-format') {
        const selection = yield* selectCandidate(probe, offset, header, true);
        probe.suffixes.set(offset, {
          credible: selection.bestMatches > 0,
          closed: probe.ended && selection.bestMatches > 0,
          indexedMatches: 0,
        });
      } else {
        probe.suffixes.set(offset, indexedEvidence(probe, offset, header));
      }
    }
  }
  return { ...(yield* selectCandidate(probe, 0, first)), ...probe.work };
}

/** Synchronous drain for exact analysis/metrics checks; production uses the cooperative driver. */
export function analyzeFreeFormatProbe(
  window: Uint8Array,
  first: FreeFormatFrameHeader,
  ended: boolean,
  minimumStreamLength: number,
): Selection & ProbeWork {
  const steps = analyzeFreeFormatProbeSteps(window, first, ended, minimumStreamLength);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Real event-loop turns, not resolved-promise microtasks; cancellation is not a format error. */
export async function runFreeFormatProbe(
  steps: Generator<ProbeWork, Selection & ProbeWork>,
  signal?: AbortSignal,
): Promise<Selection & ProbeWork> {
  signal?.throwIfAborted();
  let step = steps.next();
  while (!step.done) {
    await yieldToEventLoop(signal);
    step = steps.next();
  }
  return step.value;
}

/**
 * Structural inference, not a decoder or a universal uniqueness proof. Keep
 * EOF/metadata-anchored ordinary short streams and strongest same-configuration
 * chains. New configuration anchors must not make genuinely competing layouts
 * disappear. The byte probe and all observations are upload-length independent.
 */
export async function inferFreeFormatBaseLength(
  reader: AsyncByteReader,
  first: FreeFormatFrameHeader,
  signal?: AbortSignal,
): Promise<number> {
  const start = reader.offset;
  const ended = !(await reader.has(MAX_PROBE_BYTES + 1));
  const minimumStreamLength = Math.min(reader.bufferedLength, MAX_PROBE_BYTES + 1);
  const window = reader.peek(Math.min(reader.bufferedLength, MAX_PROBE_BYTES));
  const evidence = await runFreeFormatProbe(
    analyzeFreeFormatProbeSteps(window, first, ended, minimumStreamLength),
    signal,
  );
  if (evidence.bestMatches === 0 || evidence.tied) {
    throw new Mp3ParseError(
      'unsupported-format',
      start,
      evidence.tied
        ? 'Ambiguous free-format MPEG frame layout'
        : 'Cannot infer a unique free-format MPEG frame size within the supported 320 kb/s bitrate envelope',
    );
  }
  return evidence.bestBase;
}
