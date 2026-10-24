import { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { parseFrameHeader, looksLikeUnsupportedMpeg, isFreeFormatHeader } from './frame-header.js';
import type { FrameHeader } from './frame-header.js';
import { isId3v1Tag, isId3v2Tag, parseId3Header } from './id3.js';

/**
 * Count complete, structurally valid MPEG-1 Layer III frames.
 *
 * Counts ALL physical MPEG frames, including optional Xing/Info/VBRI metadata
 * frames. It does not decode MP3 audio or trust a VBR header's declared count.
 * Leading ID3v2, appended ID3v2.4 with a footer, and trailing ID3v1 are excluded.
 *
 * Processing is O(input bytes) with bounded lookahead (<= 10 bytes for ID3,
 * 4 bytes for each frame header); memory is O(input stream chunk size).
 */
export async function countMp3Frames(input: AsyncIterable<Uint8Array>): Promise<number> {
  const reader = new AsyncByteReader(input);
  let failed = false;
  try {
    return await countFrames(reader);
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

async function countFrames(reader: AsyncByteReader): Promise<number> {
  let tagCount = 0;
  while ((await reader.has(3)) && isId3v2Tag(reader.peek(3))) {
    if (++tagCount > 8) {
      throw new Mp3ParseError('invalid-mp3', reader.offset, 'Too many ID3v2 tags');
    }
    await skipId3v2(reader, 'leading');
  }

  let frames = 0;
  for (;;) {
    const position = reader.offset;
    if (!(await reader.has(4))) {
      if (frames === 0) {
        throw new Mp3ParseError('invalid-mp3', position, 'No MPEG-1 Layer III frames found');
      }
      if (await reader.has(1)) {
        throw new Mp3ParseError('truncated-mp3', position, 'Incomplete trailing frame header');
      }
      return frames;
    }

    const bytes = reader.peek(4);
    if (frames > 0 && (isId3v2Tag(bytes) || isId3v1Tag(bytes))) {
      await skipTrailingTags(reader);
      return frames;
    }

    const frame = requireFrameHeader(bytes, position);
    await reader.skipExactly(frame.length);
    frames++;
  }
}

async function skipId3v2(
  reader: AsyncByteReader,
  placement: 'leading' | 'trailing',
): Promise<void> {
  const position = reader.offset;
  if (!(await reader.has(10))) {
    throw new Mp3ParseError('truncated-mp3', position, 'Incomplete ID3v2 tag header');
  }
  // Keep just the header while streaming past metadata, even for large album art.
  const header = Uint8Array.from(reader.peek(10));
  const id3 = parseId3Header(header, position)!;
  if (placement === 'trailing' && !id3.hasFooter) {
    throw new Mp3ParseError(
      'invalid-mp3',
      position,
      'Appended ID3v2 tags must use version 2.4 with a footer',
    );
  }
  await reader.skipExactly(10 + id3.bodyLength);
  if (!id3.hasFooter) return;

  if (!(await reader.has(10))) {
    throw new Mp3ParseError('truncated-mp3', reader.offset, 'Incomplete ID3v2 footer');
  }
  const footer = reader.peek(10);
  // A footer copies every header byte except its reversed "3DI" signature.
  if (
    footer[0] !== 0x33 ||
    footer[1] !== 0x44 ||
    footer[2] !== 0x49 ||
    header.subarray(3).some((byte, index) => footer[index + 3] !== byte)
  ) {
    throw new Mp3ParseError('invalid-mp3', reader.offset, 'Invalid ID3v2 footer');
  }
  await reader.skipExactly(10);
}

async function skipTrailingTags(reader: AsyncByteReader): Promise<void> {
  // ID3v2.4 permits an appended tag before tags from other systems. Once a
  // trailing tag begins, only one optional final ID3v1 tag may follow it.
  if (isId3v2Tag(reader.peek(3))) await skipId3v2(reader, 'trailing');
  if ((await reader.has(3)) && isId3v1Tag(reader.peek(3))) {
    await reader.skipExactly(128);
  }
  if (await reader.has(1)) {
    throw new Mp3ParseError(
      'invalid-mp3',
      reader.offset,
      'Unexpected bytes after trailing metadata',
    );
  }
}

function requireFrameHeader(bytes: Uint8Array, offset: number): FrameHeader {
  const frame = parseFrameHeader(bytes);
  if (frame !== null) return frame;
  if (isFreeFormatHeader(bytes)) {
    throw new Mp3ParseError(
      'unsupported-format',
      offset,
      'Free-format MPEG-1 Layer III is not supported; use a table-defined bitrate',
    );
  }
  if (looksLikeUnsupportedMpeg(bytes)) {
    throw new Mp3ParseError('unsupported-format', offset, 'Only MPEG-1 Layer III is supported');
  }
  throw new Mp3ParseError('invalid-mp3', offset, 'Invalid MPEG-1 Layer III frame header');
}
