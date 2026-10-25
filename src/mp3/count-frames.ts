import { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { parseFrameHeader, looksLikeUnsupportedMpeg, isFreeFormatHeader } from './frame-header.js';
import type { FrameHeader } from './frame-header.js';
import { skipLeadingTags, skipTrailingMetadata, startsTrailingMetadata } from './id3.js';
import { inferFreeFormatBaseLength } from './free-format.js';
import { isVbrHeaderFrame } from './vbr-header.js';

/**
 * Count complete, structurally valid MPEG-1 Layer III frames.
 *
 * Counts physical MPEG frames by default. An optional policy excludes a
 * recognized first Xing/Info/VBRI frame; it does not decode MP3 audio or trust
 * encoder-declared counts.
 * Leading ID3v2, appended ID3v2.4 with a footer, and trailing ID3v1 are excluded.
 *
 * Processing is O(input bytes), with one bounded free-format probe (8.7 KiB),
 * and memory O(largest input chunk plus probe bytes).
 */
export interface Mp3CountOptions {
  readonly includeVbrHeaderFrame?: boolean;
}

export async function countMp3Frames(
  input: AsyncIterable<Uint8Array>,
  options: Mp3CountOptions = {},
): Promise<number> {
  const reader = new AsyncByteReader(input);
  let failed = false;
  try {
    return await countFrames(reader, options.includeVbrHeaderFrame !== false);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) {
      // An upstream stream can fail a second time during cleanup. Preserve
      // the original parse error rather than incorrectly returning HTTP 500.
      try {
        await reader.close();
      } catch {
        // The parse error remains the actionable failure.
      }
    } else {
      await reader.close();
    }
  }
}

async function countFrames(
  reader: AsyncByteReader,
  includeVbrHeaderFrame: boolean,
): Promise<number> {
  await skipLeadingTags(reader);

  let frames = 0;
  let excludedVbrFrame = 0;
  let bitrateMode: 'free' | 'indexed' | undefined;
  let freeBaseLength: number | undefined;
  let freeSampleRateBits: number | undefined;
  for (;;) {
    const position = reader.offset;
    if (!(await reader.has(4))) {
      if (frames === 0) {
        throw new Mp3ParseError('invalid-mp3', position, 'No MPEG-1 Layer III frames found');
      }
      if (await reader.has(1)) {
        throw new Mp3ParseError('truncated-mp3', position, 'Incomplete trailing frame header');
      }
      return frames - excludedVbrFrame;
    }

    const bytes = reader.peek(4);
    if (frames > 0 && startsTrailingMetadata(bytes)) {
      await skipTrailingMetadata(reader);
      return frames - excludedVbrFrame;
    }

    let frameLength: number;
    if (isFreeFormatHeader(bytes)) {
      if (bitrateMode === 'indexed') {
        throw new Mp3ParseError(
          'invalid-mp3',
          position,
          'Cannot mix free-format and indexed MPEG frames',
        );
      }
      bitrateMode = 'free';
      const sampleRateBits = bytes[2]! & 0x0c;
      if (freeBaseLength === undefined) {
        freeSampleRateBits = sampleRateBits;
        freeBaseLength = await inferFreeFormatBaseLength(reader);
      }
      if (sampleRateBits !== freeSampleRateBits) {
        throw new Mp3ParseError('invalid-mp3', position, 'Free-format sample rate changed');
      }
      frameLength = freeBaseLength + ((bytes[2]! >>> 1) & 1);
    } else {
      if (bitrateMode === 'free') {
        throw new Mp3ParseError(
          'invalid-mp3',
          position,
          'Cannot mix indexed and free-format MPEG frames',
        );
      }
      bitrateMode = 'indexed';
      frameLength = requireFrameHeader(bytes, position).length;
    }

    if (frames === 0 && !includeVbrHeaderFrame && (await reader.has(frameLength))) {
      if (isVbrHeaderFrame(reader.peek(frameLength))) excludedVbrFrame = 1;
    }
    await reader.skipExactly(frameLength);
    frames++;
  }
}

function requireFrameHeader(bytes: Uint8Array, offset: number): FrameHeader {
  const frame = parseFrameHeader(bytes);
  if (frame !== null) return frame;
  if (looksLikeUnsupportedMpeg(bytes)) {
    throw new Mp3ParseError('unsupported-format', offset, 'Only MPEG-1 Layer III is supported');
  }
  throw new Mp3ParseError('invalid-mp3', offset, 'Invalid MPEG-1 Layer III frame header');
}
