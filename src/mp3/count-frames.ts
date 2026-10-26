import { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { FrameSpans } from './frame-spans.js';
import { skipLeadingTags, skipFrameBoundaryMetadata, startsMetadata } from './id3.js';
import { isEncoderFrame } from './encoder-frame.js';

/**
 * Count complete, structurally valid MPEG-1 Layer III frames.
 *
 * Counts physical MPEG frames by default. An optional policy excludes a
 * recognized first Xing/Info/VBRI frame; it does not decode MP3 audio or trust
 * encoder-declared counts.
 * Boundary-aligned ID3v2, appended ID3v2.4 with footers, and final ID3v1 are skipped.
 *
 * Processing is O(input bytes), with bounded free-format lookahead (< 9 KiB),
 * and queued byte lengths O(largest input chunk plus probe bytes). Input views
 * can retain larger upstream backing buffers.
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

  const spans = new FrameSpans(reader);
  let frames = 0;
  let excludedEncoderFrame = 0;
  for (;;) {
    const position = reader.offset;
    if (!(await reader.has(4))) {
      await validateFrameSequenceEnd(reader, frames, position);
      return frames - excludedEncoderFrame;
    }
    if (frames > 0 && startsMetadata(reader.peek(4))) {
      if (await skipFrameBoundaryMetadata(reader)) return frames - excludedEncoderFrame;
      continue;
    }

    const { header, length } = await spans.resolve();
    if (frames === 0 && !includeVbrHeaderFrame && (await reader.has(length))) {
      if (isEncoderFrame(header, reader.peek(length))) excludedEncoderFrame = 1;
    }
    await reader.skipExactly(length);
    frames++;
  }
}

/** Validate EOF after a failed four-byte header lookahead. */
async function validateFrameSequenceEnd(
  reader: AsyncByteReader,
  frames: number,
  position: number,
): Promise<void> {
  if (frames === 0) {
    throw new Mp3ParseError('invalid-mp3', position, 'No MPEG-1 Layer III frames found');
  }
  if (await reader.has(1)) {
    throw new Mp3ParseError('truncated-mp3', position, 'Incomplete trailing frame header');
  }
}
