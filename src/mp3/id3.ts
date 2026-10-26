import type { AsyncByteReader } from './byte-reader.js';
import { Mp3ParseError } from './errors.js';

const SIGNATURE_BYTES = 3;
const ID3V2_HEADER_BYTES = 10;
/** An ID3v2.4 footer copies the header, apart from its reversed signature. */
const ID3V2_FOOTER_BYTES = ID3V2_HEADER_BYTES;
const ID3V2_FOOTER_SIGNATURE = [0x33, 0x44, 0x49] as const;
const ID3V2_SIZE_OFFSET = 6;
/** Versioned header masks from the ID3v2.2/2.3/2.4 author specifications. */
const ID3V2_DEFINED_FLAGS: Readonly<Record<number, number>> = { 2: 0xc0, 3: 0xe0, 4: 0xf0 };
const ID3V1_TAG_BYTES = 128;

interface TagHeader {
  readonly bytes: Uint8Array;
  readonly bodyLength: number;
  readonly hasFooter: boolean;
}

/** Stream leading tags by encoded length; every iteration consumes at least ten bytes. */
export async function skipLeadingTags(reader: AsyncByteReader): Promise<void> {
  while (await nextBytesAre(reader, isId3v2Tag)) {
    await skipTag(reader, await readTagHeader(reader));
  }
}

/** Whether bytes at a known MPEG boundary begin an ID3 signature. */
export function startsMetadata(bytes: Uint8Array): boolean {
  return isId3v2Tag(bytes) || isId3v1Tag(bytes);
}

/**
 * Conservative short-frame ambiguity evidence, not metadata recognition.
 * Validate every available ID3v2 header/footer byte. A still-plausible
 * partial envelope may be truncated; known invalid bytes are not evidence
 * of supported metadata. ID3v1 can only occupy the final 128 bytes (or
 * less if truncated), so an earlier TAG string cannot be a supported tail.
 * The lower bound includes the candidate frame's end: a bounded probe's
 * end alone is not EOF when that frame must extend beyond the probe.
 */
export function hasPossibleMetadataPrefix(
  bytes: Uint8Array,
  minimumRemainingBytes: number,
): boolean {
  if (isId3v1Tag(bytes)) return minimumRemainingBytes <= ID3V1_TAG_BYTES;
  if (!isId3v2Tag(bytes)) return false;
  try {
    const header = decodeTagHeader(bytes.subarray(0, ID3V2_HEADER_BYTES), 0);
    if (header === undefined) return true;
    const footer = ID3V2_HEADER_BYTES + header.bodyLength;
    return (
      !header.hasFooter ||
      matchesFooterPrefix(header, bytes.subarray(footer, footer + ID3V2_FOOTER_BYTES))
    );
  } catch {
    // Known invalid or unsupported bytes cannot supply metadata evidence.
  }
  return false;
}

/**
 * Stream an ID3 run at a known post-frame boundary, never by scanning
 * payload. ID3v2.2/2.3 BUF/RBUF and ID3v2.4 RBUF allow embedded tags. Only
 * a run after all audio is appended: every tag in that run needs a v2.4
 * footer. ID3v1 is always the final 128 bytes. Return true only at EOF.
 */
export async function skipFrameBoundaryMetadata(reader: AsyncByteReader): Promise<boolean> {
  let withoutFooter: number | undefined;
  while (await nextBytesAre(reader, isId3v2Tag)) {
    const offset = reader.offset;
    const header = await readTagHeader(reader);
    if (!header.hasFooter && withoutFooter === undefined) withoutFooter = offset;
    await skipTag(reader, header);
  }
  const hasV1 = await nextBytesAre(reader, isId3v1Tag);
  const atEnd = !(await reader.has(1));
  if (hasV1 || atEnd) {
    if (withoutFooter !== undefined) {
      throw new Mp3ParseError(
        'invalid-mp3',
        withoutFooter,
        'Appended ID3v2 tags must use version 2.4 with a footer',
      );
    }
    if (hasV1) await reader.skipExactly(ID3V1_TAG_BYTES);
    if (await reader.has(1)) {
      throw new Mp3ParseError(
        'invalid-mp3',
        reader.offset,
        'Unexpected bytes after trailing metadata',
      );
    }
    return true;
  }
  // The caller retains its audio mode and validates the next MPEG header.
  if (!(await reader.has(4))) {
    throw new Mp3ParseError(
      'invalid-mp3',
      reader.offset,
      'Unexpected bytes after trailing metadata',
    );
  }
  return false;
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
  return decodeTagHeader(bytes, offset)!;
}

/**
 * Validate known header bytes; a still-plausible incomplete prefix has no size.
 * Missing version/flags use supported completion witnesses only for validation,
 * never as inferred metadata: complete streaming/probe callers require ten bytes.
 */
function decodeTagHeader(bytes: Uint8Array, offset: number): TagHeader | undefined {
  const version = bytes[3] ?? 2;
  const revision = bytes[4];
  const flags = bytes[5] ?? 0;
  if (version < 2 || version > 4 || revision === 0xff) {
    throw new Mp3ParseError('unsupported-format', offset, 'Unsupported ID3v2 version');
  }
  const definedFlags = ID3V2_DEFINED_FLAGS[version]!;
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
  if (bytes.length < ID3V2_HEADER_BYTES) return undefined;
  // ID3v2.2/2.3/2.4 tag size is a 28-bit synchsafe integer.
  const bodyLength =
    (sizeBytes[0]! << 21) | (sizeBytes[1]! << 14) | (sizeBytes[2]! << 7) | sizeBytes[3]!;
  return { bytes, bodyLength, hasFooter: version === 4 && (flags & 0x10) !== 0 };
}

/** Skip the already-inspected ID3v2 header and body, then verify and skip any footer. */
async function skipTag(reader: AsyncByteReader, header: TagHeader): Promise<void> {
  await reader.skipExactly(ID3V2_HEADER_BYTES + header.bodyLength);
  if (!header.hasFooter) return;

  if (!(await reader.has(ID3V2_FOOTER_BYTES))) {
    throw new Mp3ParseError('truncated-mp3', reader.offset, 'Incomplete ID3v2 footer');
  }
  const footer = reader.peek(ID3V2_FOOTER_BYTES);
  if (!matchesFooterPrefix(header, footer)) {
    throw new Mp3ParseError('invalid-mp3', reader.offset, 'Invalid ID3v2 footer');
  }
  await reader.skipExactly(ID3V2_FOOTER_BYTES);
}

/** Compare only supplied footer bytes; strict callers separately require all ten. */
function matchesFooterPrefix(header: TagHeader, footer: Uint8Array): boolean {
  return footer.every(
    (byte, index) =>
      byte === (index < SIGNATURE_BYTES ? ID3V2_FOOTER_SIGNATURE[index] : header.bytes[index]),
  );
}

interface MetadataProbe {
  readonly offset: number;
  readonly canEnd: boolean;
  readonly tags: number;
}

/**
 * Inspect metadata only at a proposed free-format boundary in the bounded
 * probe. A complete validated header may anchor a larger tag: the streaming
 * skipper still consumes its body and validates its footer later. No tag
 * content is searched or retained. An incomplete header leaves offset at
 * ID3; a larger validated envelope ends beyond the probe. Both stop MPEG
 * acquisition. canEnd matters only when offset equals the probe's EOF.
 * Undefined means this candidate cannot cross the metadata, not that
 * arbitrary payload is a malformed tag.
 */
export function probeMetadata(
  bytes: Uint8Array,
  start: number,
  ended: boolean,
): MetadataProbe | undefined {
  let offset = start;
  let tags = 0;
  let canEnd = true;
  while (isId3v2Tag(bytes.subarray(offset, offset + SIGNATURE_BYTES))) {
    if (offset + ID3V2_HEADER_BYTES > bytes.length) {
      return { offset, canEnd, tags };
    }
    tags++;
    const envelope = probeTagEnvelope(bytes, offset);
    if (envelope === undefined) return undefined;
    canEnd = canEnd && envelope.hasFooter;
    offset = envelope.end;
  }
  if (isId3v1Tag(bytes.subarray(offset, offset + SIGNATURE_BYTES))) {
    // An unproved tail adds no evidence, but must not erase preceding
    // validated ID3v2 anchors. Streaming traversal validates this tail later.
    if (!ended || offset + ID3V1_TAG_BYTES !== bytes.length) return { offset, canEnd, tags };
    offset += ID3V1_TAG_BYTES;
    tags++;
  }
  return { offset, canEnd, tags };
}

/** Validate a complete probe header and every available byte of its declared footer. */
function probeTagEnvelope(
  bytes: Uint8Array,
  offset: number,
): { end: number; hasFooter: boolean } | undefined {
  try {
    const header = decodeTagHeader(bytes.subarray(offset, offset + ID3V2_HEADER_BYTES), offset)!;
    const footer = offset + ID3V2_HEADER_BYTES + header.bodyLength;
    const end = footer + (header.hasFooter ? ID3V2_FOOTER_BYTES : 0);
    if (header.hasFooter && !matchesFooterPrefix(header, bytes.subarray(footer, end)))
      return undefined;
    return { end, hasFooter: header.hasFooter };
  } catch {
    // An impossible envelope cannot anchor this candidate.
  }
  return undefined;
}
