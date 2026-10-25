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
type BitrateMode = { readonly kind: 'indexed' } | FreeFormatMode;
const INDEXED: BitrateMode = { kind: 'indexed' };

/**
 * Resolves the span of each physical frame in one stream. An indexed frame's
 * length comes from its decoded header. A free-format stream's base length is
 * discovered once, from its first frames, and locked together with its sample
 * rate; each frame then adds its own padding. One stream never mixes the two.
 */
export class FrameSpans {
  private mode: BitrateMode | undefined;
  private readonly reader: AsyncByteReader;

  constructor(reader: AsyncByteReader) {
    this.reader = reader;
  }

  /**
   * Resolve the span of the frame at the reader's position, which must have
   * four bytes buffered. The reader does not move.
   */
  async resolve(): Promise<FrameSpan> {
    const offset = this.reader.offset;
    const header = decodeFrameHeader(this.reader.peek(4));
    // Mixing is reported before an invalid or unsupported header.
    if (this.mode?.kind === 'indexed' && header.kind === 'free-format') {
      throw new Mp3ParseError(
        'invalid-mp3',
        offset,
        'Cannot mix free-format and indexed MPEG frames',
      );
    }
    if (this.mode?.kind === 'free-format' && header.kind !== 'free-format') {
      throw new Mp3ParseError(
        'invalid-mp3',
        offset,
        'Cannot mix indexed and free-format MPEG frames',
      );
    }
    if (header.kind === 'unsupported') {
      throw new Mp3ParseError('unsupported-format', offset, 'Only MPEG-1 Layer III is supported');
    }
    if (header.kind === 'invalid') {
      throw new Mp3ParseError('invalid-mp3', offset, 'Invalid MPEG-1 Layer III frame header');
    }
    if (header.kind === 'indexed') {
      this.mode = INDEXED;
      return { header, length: header.length };
    }
    const mode = this.mode?.kind === 'free-format' ? this.mode : await this.discover(header);
    if (header.sampleRateIndex !== mode.sampleRateIndex) {
      throw new Mp3ParseError('invalid-mp3', offset, 'Free-format sample rate changed');
    }
    return { header, length: mode.baseLength + header.padding };
  }

  /** Discover and lock a free-format stream's base length and sample rate from its first frames. */
  private async discover(first: FreeFormatFrameHeader): Promise<FreeFormatMode> {
    const mode: FreeFormatMode = {
      kind: 'free-format',
      baseLength: await inferFreeFormatBaseLength(this.reader, first),
      sampleRateIndex: first.sampleRateIndex,
    };
    this.mode = mode;
    return mode;
  }
}
