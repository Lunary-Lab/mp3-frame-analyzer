import { decodeFrameHeader, type FrameHeader, type FreeFormatFrameHeader } from './frame-header.js';
import { hasPossibleMetadataPrefix, probeMetadata, startsMetadata } from './id3.js';
import { minimumFrameDataSpan } from './side-information.js';

export interface Candidate {
  readonly base: number;
  readonly matches: number;
  readonly anchored: boolean;
  readonly metadataMatches: number;
  readonly transition: boolean;
  readonly closed: boolean;
  readonly frames: readonly { start: number; end: number; header: FreeFormatFrameHeader }[];
}
/** A scheduling quantum, never a limit on admissible MPEG evidence. */
export const FREE_FORMAT_WORK_QUANTUM = 2_048;

export interface ProbeWork {
  candidates: number;
  followedFrames: number;
  metadataSteps: number;
}
export interface SuffixEvidence {
  readonly credible: boolean;
  readonly closed: boolean;
  readonly indexedMatches: number;
}
export type TargetHeader = Extract<FrameHeader, { kind: 'indexed' | 'free-format' }>;
export type Metadata = ReturnType<typeof probeMetadata>;

/** Fixed-size cached observations; no state grows with the uploaded byte count. */
export class Probe {
  readonly headers = new Map<number, TargetHeader>();
  readonly landmarks: number[] = [];
  readonly suffixes = new Map<number, SuffixEvidence>();
  readonly work: ProbeWork = { candidates: 0, followedFrames: 0, metadataSteps: 0 };
  private workTotal = 0;
  private nextYield = FREE_FORMAT_WORK_QUANTUM;
  private readonly metadata = new Map<number, Metadata>();
  private readonly minimumDataSpans = new Map<number, number | undefined>();
  private readonly freePrefixes: Uint16Array[];
  private readonly id3Prefixes: Uint16Array;
  private readonly tailPrefixes: Uint16Array;

  readonly window: Uint8Array;
  readonly ended: boolean;
  readonly minimumStreamLength: number;

  constructor(window: Uint8Array, ended: boolean, minimumStreamLength: number) {
    this.window = window;
    this.ended = ended;
    this.minimumStreamLength = minimumStreamLength;
    this.freePrefixes = Array.from({ length: 3 }, () => new Uint16Array(window.length + 1));
    this.id3Prefixes = new Uint16Array(window.length + 1);
    this.tailPrefixes = new Uint16Array(window.length + 1);
    for (let offset = 0; offset < window.length; offset++) this.indexOffset(offset);
    if (ended) this.landmarks.push(window.length);
  }

  private indexOffset(offset: number): void {
    const bytes = this.window.subarray(offset);
    const target = targetHeaderAt(this.window, offset);
    if (target !== undefined) this.headers.set(offset, target);
    const tag = startsMetadata(bytes);
    if (target !== undefined || tag) this.landmarks.push(offset);
    this.indexFreeHeader(offset, target);
    const tail = tag && bytes[0] === 0x54;
    this.tailPrefixes[offset + 1] = this.tailPrefixes[offset]! + Number(tail);
    this.id3Prefixes[offset + 1] =
      this.id3Prefixes[offset]! + Number(tag && !tail && hasPossibleMetadataPrefix(bytes, 0));
  }

  private indexFreeHeader(offset: number, target: TargetHeader | undefined): void {
    for (let rate = 0; rate < 3; rate++) {
      const prefix = this.freePrefixes[rate]!;
      prefix[offset + 1] =
        prefix[offset]! + Number(target?.kind === 'free-format' && target.sampleRateIndex === rate);
    }
  }

  boundary(offset: number): Metadata {
    if (!this.metadata.has(offset)) {
      const metadata = probeMetadata(this.window, offset, this.ended);
      // A failed envelope does not expose its traversed tag count. Charge
      // the maximum possible ten-byte iterations in its remaining window.
      const steps =
        metadata === undefined
          ? Math.floor((this.window.length - offset) / 10) + 1
          : metadata.tags + 1;
      this.reserve(steps);
      this.work.metadataSteps += steps;
      this.metadata.set(offset, metadata);
    }
    return this.metadata.get(offset);
  }

  /** Locate eligible boundaries without rescanning earlier landmarks for each suffix. */
  landmarkStart(minimum: number): number {
    let low = 0;
    let high = this.landmarks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.landmarks[middle]! < minimum) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  visitCandidate(): void {
    this.reserve(1);
    this.work.candidates++;
  }

  visitFrame(): void {
    this.reserve(1);
    this.work.followedFrames++;
  }

  private reserve(steps: number): void {
    this.workTotal += steps;
  }

  /** Called between bounded candidate walks; no evidence is discarded on yielding. */
  shouldYield(): boolean {
    if (this.workTotal < this.nextYield) return false;
    this.nextYield = this.workTotal + FREE_FORMAT_WORK_QUANTUM;
    return true;
  }

  /**
   * Necessary capacity only, not reservoir validation or audio decoding.
   * ISO/IEC 11172-3 sections 2.4.2.7 and 2.4.3.4.3: the declared main-data
   * bits must fit before the next header, including the claimed look-back.
   */
  frameMayFit(start: number, end: number, header: TargetHeader): boolean {
    const prefix = 4 + (header.hasCrc ? 2 : 0) + (header.mono ? 17 : 32);
    if (end - start < prefix) return false;
    if (!this.minimumDataSpans.has(start)) {
      this.minimumDataSpans.set(start, minimumFrameDataSpan(this.window, start, header));
    }
    const required = this.minimumDataSpans.get(start);
    return required === undefined ? !this.ended : end - start >= required;
  }

  /** Use complete-walk header evidence when supplied; metadata checks remain unchanged. */
  shortIsUnambiguous(candidate: Candidate, freeHeaderEvidence?: Uint16Array): boolean {
    for (const { start, end, header } of candidate.frames) {
      const minimum = 4 + (header.hasCrc ? 2 : 0) + (header.mono ? 17 : 32);
      if (end - start < minimum) return false;
      if (
        this.any(
          freeHeaderEvidence ?? this.freePrefixes[header.sampleRateIndex]!,
          start + 4,
          end - 4,
        ) ||
        this.any(this.id3Prefixes, start + 4, end - 3) ||
        this.any(
          this.tailPrefixes,
          Math.max(start + 4, Math.max(this.minimumStreamLength, end) - 128),
          end - 3,
        )
      )
        return false;
    }
    return true;
  }

  private any(prefix: Uint16Array, from: number, through: number): boolean {
    const stop = Math.min(through + 1, this.window.length);
    return from < stop && prefix[stop]! > prefix[from]!;
  }
}

/** One root's EOF-only fallback; retains at most two frames per deferred candidate. */
export class ClosedShortCandidates {
  private readonly headers = new Set<number>();
  private readonly deferred: Candidate[] = [];
  private readonly probe: Probe;
  private readonly enabled: boolean;

  constructor(probe: Probe, first: FreeFormatFrameHeader, root: boolean) {
    this.probe = probe;
    this.enabled =
      root &&
      ![...probe.headers.values()].some(
        (header) =>
          header.kind !== 'free-format' || header.sampleRateIndex !== first.sampleRateIndex,
      );
  }

  observe(candidate: Candidate): void {
    if (
      !this.enabled ||
      !candidate.closed ||
      !candidate.frames.every(({ start, end, header }) =>
        this.probe.frameMayFit(start, end, header),
      )
    )
      return;
    // A plausible metadata marker is uncertainty, not proof a complete walk
    // is impossible. Preserve its header evidence even when it cannot win.
    for (const frame of candidate.frames) this.headers.add(frame.start);
    if (candidate.matches < 3) this.deferred.push(candidate);
  }

  *candidates(): Generator<Candidate> {
    if (this.deferred.length === 0) return;
    // Construct once at the root, never for each suffix or each candidate.
    const prefix = new Uint16Array(this.probe.window.length);
    for (const offset of this.headers) prefix[offset + 1] = 1;
    for (let index = 1; index < prefix.length; index++) prefix[index]! += prefix[index - 1]!;
    for (const candidate of this.deferred)
      if (this.probe.shortIsUnambiguous(candidate, prefix)) yield candidate;
  }
}

function targetHeaderAt(window: Uint8Array, offset: number): TargetHeader | undefined {
  if (offset + 4 > window.length || window[offset] !== 0xff) return undefined;
  const header = decodeFrameHeader(window.subarray(offset, offset + 4));
  return header.kind === 'free-format' || header.kind === 'indexed' ? header : undefined;
}
