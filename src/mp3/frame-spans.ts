import type { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { decodeFrameHeader, type FrameHeader, type FreeFormatFrameHeader } from './frame-header.js';
import { inferFreeFormatBaseLength } from './free-format.js';

/** A physical frame's decoded header and its span in bytes. */
export interface FrameSpan {
  readonly header: FrameHeader;
  readonly length: number;
}

interface FreeFormatMode {
  readonly kind: 'free-format';
  readonly baseLength: number;
  readonly sampleRateIndex: number;
}
type BitrateMode = { readonly kind: 'indexed'; readonly sampleRateIndex: number } | FreeFormatMode;

/**
 * Resolves the span of each physical frame in one stream. An indexed frame's
 * length comes from its decoded header. A free-format stream's base length is
 * discovered once, from its first frames, and locked together with its sample
 * rate; each frame then adds its own padding. A resolved sample-rate change
 * starts a new configuration. Same-rate mode switching retains existing policy.
 */
export class FrameSpans {
  private mode: BitrateMode | undefined;
  private readonly reader: AsyncByteReader;
  private readonly signal: AbortSignal | undefined;

  constructor(reader: AsyncByteReader, signal?: AbortSignal) {
    this.reader = reader;
    this.signal = signal;
  }

  /**
   * Resolve the span of the frame at the reader's position, which must have
   * four bytes buffered. The reader does not move.
   */
  async resolve(): Promise<FrameSpan> {
    const offset = this.reader.offset;
    const header = decodeFrameHeader(this.reader.peek(4));
    if (header.kind === 'unsupported') {
      throw new Mp3ParseError('unsupported-format', offset, 'Only MPEG-1 Layer III is supported');
    }
    if (header.kind === 'invalid') {
      throw new Mp3ParseError('invalid-mp3', offset, 'Invalid MPEG-1 Layer III frame header');
    }
    this.prepareMode(header, offset);
    if (header.kind === 'indexed') {
      this.mode = { kind: 'indexed', sampleRateIndex: header.sampleRateIndex };
      return { header, length: header.length };
    }
    const mode = this.mode?.kind === 'free-format' ? this.mode : await this.discover(header);
    const length = mode.baseLength + header.padding;
    validateFreeFormatPrefix(header, length, offset);
    return { header, length };
  }

  private prepareMode(
    header: Exclude<FrameHeader, { kind: 'invalid' | 'unsupported' }>,
    offset: number,
  ): void {
    // A changed sampling rate starts a new in-scope configuration under the
    // project's successive-sequence compatibility policy. Decode first: an
    // invalid or identified unsupported header cannot reset parser state.
    if (this.mode !== undefined && this.mode.sampleRateIndex !== header.sampleRateIndex) {
      this.mode = undefined;
    }
    // Mixing needs two valid MPEG-1 Layer III headers; invalid and unsupported
    // headers report themselves first, after free-format and indexed frames alike.
    if (this.mode !== undefined && this.mode.kind !== header.kind) {
      throw new Mp3ParseError(
        'invalid-mp3',
        offset,
        header.kind === 'free-format'
          ? 'Cannot mix free-format and indexed MPEG frames'
          : 'Cannot mix indexed and free-format MPEG frames',
      );
    }
  }

  /** Discover and lock a free-format stream's base length and sample rate from its first frames. */
  private async discover(first: FreeFormatFrameHeader): Promise<FreeFormatMode> {
    const mode: FreeFormatMode = {
      kind: 'free-format',
      baseLength: await inferFreeFormatBaseLength(this.reader, first, this.signal),
      sampleRateIndex: first.sampleRateIndex,
    };
    this.mode = mode;
    return mode;
  }
}

function validateFreeFormatPrefix(header: FreeFormatFrameHeader, length: number, offset: number) {
  // Every current span must fit its 4-byte header, optional CRC and mandatory
  // side information. These bytes cannot come from the bit reservoir.
  const minimum = 4 + (header.hasCrc ? 2 : 0) + (header.mono ? 17 : 32);
  if (length < minimum) {
    throw new Mp3ParseError(
      'invalid-mp3',
      offset,
      'Free-format frame is smaller than its header and side information',
    );
  }
}
