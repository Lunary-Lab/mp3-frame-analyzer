import { Mp3ParseError } from './errors.js';

export interface Id3Header {
  readonly bodyLength: number;
  readonly totalLength: number;
  readonly hasFooter: boolean;
}

/** ID3v2.2/2.3/2.4 tag size is a 28-bit synchsafe integer. */
export function parseId3Header(bytes: Uint8Array, offset: number): Id3Header | null {
  if (bytes.length < 3) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  if (bytes.length < 10) {
    throw new Mp3ParseError('truncated-mp3', offset, 'Incomplete ID3v2 header');
  }

  const version = bytes[3]!;
  const revision = bytes[4]!;
  const flags = bytes[5]!;
  if (version < 2 || version > 4 || revision === 0xff) {
    throw new Mp3ParseError('unsupported-format', offset, 'Unsupported ID3v2 version');
  }
  const definedFlags = version === 4 ? 0xf0 : version === 3 ? 0xe0 : 0xc0;
  if ((flags & ~definedFlags) !== 0) {
    throw new Mp3ParseError('invalid-mp3', offset, 'Reserved ID3v2 flags are set');
  }

  for (let i = 6; i < 10; i++) {
    if ((bytes[i]! & 0x80) !== 0) {
      throw new Mp3ParseError('invalid-mp3', offset + i, 'Invalid synchsafe ID3v2 size');
    }
  }
  const bodyLength =
    (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
  const hasFooter = version === 4 && (flags & 0x10) !== 0;
  return { bodyLength, totalLength: 10 + bodyLength + (hasFooter ? 10 : 0), hasFooter };
}

export function isId3v1Tag(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0x54 && bytes[1] === 0x41 && bytes[2] === 0x47;
}
