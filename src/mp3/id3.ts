import type { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';

const MAX_LEADING_TAGS = 8;
const SIGNATURE_BYTES = 3;
const ID3V2_HEADER_BYTES = 10;
/** An ID3v2.4 footer copies the header, apart from its reversed signature. */
const ID3V2_FOOTER_BYTES = ID3V2_HEADER_BYTES;
const ID3V2_SIZE_OFFSET = 6;
const ID3V1_TAG_BYTES = 128;

interface TagHeader {
  readonly bytes: Uint8Array;
  readonly bodyLength: number;
  readonly hasFooter: boolean;
}

/** Skip up to eight leading tags at the start of the stream by their encoded lengths. */
export async function skipLeadingTags(reader: AsyncByteReader): Promise<void> {
  let tags = 0;
  while (await nextBytesAre(reader, isId3v2Tag)) {
    if (++tags > MAX_LEADING_TAGS) {
      throw new Mp3ParseError('invalid-mp3', reader.offset, 'Too many ID3v2 tags');
    }
    await skipTag(reader, await readTagHeader(reader));
  }
}

/** Whether bytes at a frame boundary begin trailing metadata rather than a frame. */
export function startsTrailingMetadata(bytes: Uint8Array): boolean {
  return isId3v2Tag(bytes) || isId3v1Tag(bytes);
}

/**
 * Skip trailing metadata through the end of the stream. Call it only where
 * startsTrailingMetadata matched the next bytes. ID3v2.4 permits an appended
 * tag before tags from other systems, so it must carry a footer; after it,
 * only one final ID3v1 tag may follow.
 */
export async function skipTrailingMetadata(reader: AsyncByteReader): Promise<void> {
  if (isId3v2Tag(reader.peek(SIGNATURE_BYTES))) {
    const offset = reader.offset;
    const header = await readTagHeader(reader);
    if (!header.hasFooter) {
      throw new Mp3ParseError(
        'invalid-mp3',
        offset,
        'Appended ID3v2 tags must use version 2.4 with a footer',
      );
    }
    await skipTag(reader, header);
  }
  if (await nextBytesAre(reader, isId3v1Tag)) {
    await reader.skipExactly(ID3V1_TAG_BYTES);
  }
  if (await reader.has(1)) {
    throw new Mp3ParseError(
      'invalid-mp3',
      reader.offset,
      'Unexpected bytes after trailing metadata',
    );
  }
}

async function nextBytesAre(
  reader: AsyncByteReader,
  signature: (bytes: Uint8Array) => boolean,
): Promise<boolean> {
  return (await reader.has(SIGNATURE_BYTES)) && signature(reader.peek(SIGNATURE_BYTES));
}

function isId3v2Tag(bytes: Uint8Array): boolean {
  return bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
}

function isId3v1Tag(bytes: Uint8Array): boolean {
  return bytes[0] === 0x54 && bytes[1] === 0x41 && bytes[2] === 0x47;
}

/** Read and validate the header of the ID3v2 tag at the reader's position. */
async function readTagHeader(reader: AsyncByteReader): Promise<TagHeader> {
  const offset = reader.offset;
  if (!(await reader.has(ID3V2_HEADER_BYTES))) {
    throw new Mp3ParseError('truncated-mp3', offset, 'Incomplete ID3v2 tag header');
  }
  // Keep just the header while streaming past metadata, even for large album art.
  const bytes = Uint8Array.from(reader.peek(ID3V2_HEADER_BYTES));
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
  const sizeBytes = bytes.subarray(ID3V2_SIZE_OFFSET);
  const invalidSizeByte = sizeBytes.findIndex((byte) => (byte & 0x80) !== 0);
  if (invalidSizeByte !== -1) {
    throw new Mp3ParseError(
      'invalid-mp3',
      offset + ID3V2_SIZE_OFFSET + invalidSizeByte,
      'Invalid synchsafe ID3v2 size',
    );
  }
  // ID3v2.2/2.3/2.4 tag size is a 28-bit synchsafe integer.
  const bodyLength =
    (sizeBytes[0]! << 21) | (sizeBytes[1]! << 14) | (sizeBytes[2]! << 7) | sizeBytes[3]!;
  return { bytes, bodyLength, hasFooter: version === 4 && (flags & 0x10) !== 0 };
}

/** Skip an ID3v2 tag whose header has been read: its body, then any footer, verified. */
async function skipTag(reader: AsyncByteReader, header: TagHeader): Promise<void> {
  await reader.skipExactly(ID3V2_HEADER_BYTES + header.bodyLength);
  if (!header.hasFooter) return;

  if (!(await reader.has(ID3V2_FOOTER_BYTES))) {
    throw new Mp3ParseError('truncated-mp3', reader.offset, 'Incomplete ID3v2 footer');
  }
  const footer = reader.peek(ID3V2_FOOTER_BYTES);
  if (
    footer[0] !== 0x33 ||
    footer[1] !== 0x44 ||
    footer[2] !== 0x49 ||
    header.bytes
      .subarray(SIGNATURE_BYTES)
      .some((byte, index) => footer[index + SIGNATURE_BYTES] !== byte)
  ) {
    throw new Mp3ParseError('invalid-mp3', reader.offset, 'Invalid ID3v2 footer');
  }
  await reader.skipExactly(ID3V2_FOOTER_BYTES);
}
