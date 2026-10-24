import { parseFrameHeader, isFreeFormatHeader } from './frame-header.js';

/** All signature offsets are positive constants determined by MPEG-1 headers. */
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
 * Identify a genuine, initial MPEG-1 Layer III Xing/Info/LAME or VBRI frame.
 * LAME is an extension to Xing/Info, never an independent MPEG frame.
 * Do not search arbitrary payload positions or trust embedded frame counts.
 */
export function isVbrHeaderFrame(frame: Uint8Array): boolean {
  const header = parseFrameHeader(frame.subarray(0, 4));
  const freeFormat = isFreeFormatHeader(frame.subarray(0, 4));
  if ((!header && !freeFormat) || (header && frame.length !== header.length)) return false;
  const mono = (frame[3]! & 0xc0) === 0xc0;
  const xingPosition = mono ? 21 : 36;
  return (
    xingAt(frame, xingPosition) ||
    ((frame[1]! & 1) === 0 && xingAt(frame, xingPosition + 2)) ||
    vbriAt(frame)
  );
}
