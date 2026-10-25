import { countMp3Frames } from '../dist/mp3/count-frames.js';
import { Mp3ParseError } from '../dist/mp3/errors.js';

/** Byte chunking is independent from framing and must not change the result. */
export async function* chunks(bytes, size) {
  for (let pos = 0; pos < bytes.length; pos += size) {
    yield bytes.subarray(pos, Math.min(bytes.length, pos + size));
  }
}

export async function outcome(bytes, chunkSize, options = {}) {
  try {
    const count = await countMp3Frames(chunks(bytes, chunkSize), options);
    // Indexed frames are at least 96 bytes, but a free-format frame can be as
    // small as 24 bytes (8 kbps at 48 kHz), the parser's minimum inferred span.
    // Excluding a lone initial encoder frame can leave zero audio frames.
    const fewestValidFrames = options.includeVbrHeaderFrame === false ? 0 : 1;
    if (!Number.isSafeInteger(count) || count < fewestValidFrames || count * 24 > bytes.length) {
      throw new Error(`Impossible frame count: ${count} for ${bytes.length} bytes`);
    }
    return { kind: 'success', count };
  } catch (error) {
    if (error instanceof Mp3ParseError) {
      return { kind: 'rejection', code: error.kind, offset: error.offset };
    }
    throw error;
  }
}

export function assertSameOutcome(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`Chunk-boundary dependence: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}
