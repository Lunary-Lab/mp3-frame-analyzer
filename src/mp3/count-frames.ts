import { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';
import { parseFrameHeader, looksLikeUnsupportedMpeg } from './frame-header.js';
import { isId3v1Tag, parseId3Header } from './id3.js';

/**
 * Count complete, structurally valid MPEG-1 Layer III frames.
 *
 * Counts ALL physical MPEG frames, including optional Xing/Info/VBRI metadata
 * frames. It does not decode MP3 audio or trust a VBR header's declared count.
 * Leading ID3v2 and trailing ID3v1 tags are excluded.
 *
 * Processing is O(input bytes) with bounded lookahead (<= 10 bytes for ID3,
 * 4 bytes for each frame header); memory is O(input stream chunk size).
 */
export async function countMp3Frames(input: AsyncIterable<Uint8Array>): Promise<number> {
  const reader = new AsyncByteReader(input);

  // ID3v2 tags appear before MPEG audio data. Their body can be large; skip
  // incrementally instead of buffering even a single album-art image.
  let tagCount = 0;
  while (await reader.has(3)) {
    const prefix = reader.peek(3);
    if (prefix[0] !== 0x49 || prefix[1] !== 0x44 || prefix[2] !== 0x33) break;
    if (++tagCount > 8) {
      throw new Mp3ParseError('invalid-mp3', reader.offset, 'Too many ID3v2 tags');
    }
    const position = reader.offset;
    if (!(await reader.has(10))) {
      throw new Mp3ParseError('truncated-mp3', position, 'Incomplete ID3v2 tag header');
    }
    const id3 = parseId3Header(reader.peek(10), position)!;
    await reader.skipExactly(10 + id3.bodyLength);
    if (id3.hasFooter) {
      if (!(await reader.has(10))) {
        throw new Mp3ParseError('truncated-mp3', reader.offset, 'Incomplete ID3v2 footer');
      }
      const footer = reader.peek(10);
      if (footer[0] !== 0x33 || footer[1] !== 0x44 || footer[2] !== 0x49) {
        throw new Mp3ParseError('invalid-mp3', reader.offset, 'Invalid ID3v2 footer');
      }
      await reader.skipExactly(10);
    }
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
    // ID3v1 is exactly 128 bytes and is permitted only at the end.
    if (frames > 0 && isId3v1Tag(bytes)) {
      await reader.skipExactly(128);
      if (await reader.has(1)) {
        throw new Mp3ParseError('invalid-mp3', reader.offset, 'Unexpected bytes after ID3v1');
      }
      return frames;
    }

    const frame = parseFrameHeader(bytes);
    if (frame === null) {
      if (looksLikeUnsupportedMpeg(bytes)) {
        throw new Mp3ParseError('unsupported-format', position, 'Only MPEG-1 Layer III is supported');
      }
      throw new Mp3ParseError('invalid-mp3', position, 'Invalid MPEG-1 Layer III frame header');
    }

    await reader.skipExactly(frame.length);
    frames++;
  }
}
