import type { FrameHeader } from './frame-header.js';

/** Callers use fixed positive offsets from the supported encoder conventions. */
const textAt = (frame: Uint8Array, offset: number, text: string): boolean =>
  offset + text.length <= frame.length &&
  [...text].every((character, index) => frame[offset + index] === character.charCodeAt(0));

function unsigned32(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset]!;
  const b = bytes[offset + 1]!;
  const c = bytes[offset + 2]!;
  const d = bytes[offset + 3]!;
  return (a * 0x1000000 + (b << 16) + (c << 8) + d) >>> 0;
}

function xingAt(frame: Uint8Array, position: number): boolean {
  if (!textAt(frame, position, 'Xing') && !textAt(frame, position, 'Info')) return false;
  if (position + 8 > frame.length) return false;
  const flags = unsigned32(frame, position + 4);
  if ((flags & ~0x0f) !== 0) return false;
  const required =
    position +
    8 +
    ((flags & 1) !== 0 ? 4 : 0) +
    ((flags & 2) !== 0 ? 4 : 0) +
    ((flags & 4) !== 0 ? 100 : 0) +
    ((flags & 8) !== 0 ? 4 : 0);
  return required <= frame.length;
}

function vbriAt(frame: Uint8Array): boolean {
  const position = 36;
  if (!textAt(frame, position, 'VBRI') || position + 26 > frame.length) return false;
  const version = (frame[position + 4]! << 8) | frame[position + 5]!;
  if (version !== 1) return false;
  const entryCount = (frame[position + 18]! << 8) | frame[position + 19]!;
  const entryWidth = (frame[position + 22]! << 8) | frame[position + 23]!;
  return (
    entryCount > 0 &&
    entryWidth >= 1 &&
    entryWidth <= 4 &&
    position + 26 + entryCount * entryWidth <= frame.length
  );
}

/**
 * Whether a complete physical frame carries Xing/Info (optionally extended by
 * LAME) or VBRI metadata at the supported conventional offsets. Traversal asks
 * only about the stream's first frame, which makes such a frame its encoder
 * frame. `frame` holds exactly the frame's span. LAME is an extension to
 * Xing/Info, never an independent MPEG frame. Do not search arbitrary payload
 * positions or trust embedded frame counts.
 */
export function isEncoderFrame(header: FrameHeader, frame: Uint8Array): boolean {
  const xingPosition = header.mono ? 21 : 36;
  return (
    xingAt(frame, xingPosition) ||
    (header.hasCrc && xingAt(frame, xingPosition + 2)) ||
    vbriAt(frame)
  );
}
