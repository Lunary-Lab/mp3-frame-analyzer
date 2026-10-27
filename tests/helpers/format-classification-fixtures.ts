import type { Mp3ErrorKind } from '../../src/mp3/errors.js';
import { frame, id3v2 } from './mp3-fixtures.js';

export interface RejectionCase {
  readonly label: string;
  readonly bytes: Buffer;
  readonly kind: Mp3ErrorKind;
  readonly message: string;
}

export const invalidHeader = 'Invalid MPEG-1 Layer III frame header';
export const unsupportedHeader = 'Only MPEG-1 Layer III is supported';
export const forbiddenId3Version = 'ID3v2 version and revision must not be 0xff';

/** Four bytes classify identifiers, not the decodability of an unsupported codec. */
export function headerIdentifier(version: number, layer: number): Buffer {
  return Buffer.from([0xff, 0xe1 | (version << 3) | (layer << 1), 0x90, 0]);
}

export const headerCases: RejectionCase[] = [];
for (const version of [0, 1, 2, 3]) {
  for (const layer of [0, 1, 2, 3]) {
    if (version === 3 && layer === 1) continue;
    const reserved = version === 1 || layer === 0;
    headerCases.push({
      label: `version bits ${version.toString(2).padStart(2, '0')}, layer bits ${layer.toString(2).padStart(2, '0')}`,
      bytes: headerIdentifier(version, layer),
      kind: reserved ? 'invalid-mp3' : 'unsupported-format',
      message: reserved ? invalidHeader : unsupportedHeader,
    });
  }
}
for (const [label, bytes] of [
  ['forbidden bitrate', [0xff, 0xfb, 0xf0, 0]],
  ['reserved sample rate', [0xff, 0xfb, 0x9c, 0]],
  ['reserved emphasis', [0xff, 0xfb, 0x90, 2]],
  ['missing sync', [0, 0xfb, 0x90, 0]],
  ['arbitrary non-MPEG bytes', [0x6e, 0x6f, 0x70, 0x65]],
] as const) {
  headerCases.push({
    label,
    bytes: Buffer.from(bytes),
    kind: 'invalid-mp3',
    message: invalidHeader,
  });
}

export function tagVersion(version: number, revision = 0): Buffer {
  const bytes = id3v2(Buffer.alloc(0));
  bytes[3] = version;
  bytes[4] = revision;
  return bytes;
}

export const tagCases: RejectionCase[] = [0, 1, 5, 254].map((version) => ({
  label: `unknown ID3 major ${version}`,
  bytes: tagVersion(version),
  kind: 'unsupported-format',
  message: 'Unsupported ID3v2 version',
}));
for (const [version, revision] of [
  [255, 0],
  [255, 255],
  [2, 255],
  [3, 255],
  [4, 255],
  [5, 255],
]) {
  tagCases.push({
    label: `forbidden ID3 version/revision ${version}/${revision}`,
    bytes: tagVersion(version!, revision),
    kind: 'invalid-mp3',
    message: forbiddenId3Version,
  });
}

/** Enough complete free frames to lock the span before an independently bad boundary. */
export function lockedFreeFormat(): Buffer {
  const bytes = Buffer.alloc(4 * 800, 0x11);
  for (const offset of [0, 800, 1600, 2400]) bytes.set([0xff, 0xfb, 0, 0xc0], offset);
  return bytes;
}

/** Independent length geometry; all indexed bitrates, rates, CRC, padding and modes. */
export function indexedVariants(sampleRateIndex: number): Buffer[] {
  const frames: Buffer[] = [];
  for (let bitrateIndex = 1; bitrateIndex <= 14; bitrateIndex++) {
    for (const padding of [0, 1] as const) {
      for (const hasCrc of [false, true]) {
        for (const channel of [0, 1, 2, 3]) {
          const bytes = frame({ bitrateIndex, sampleRateIndex, padding, hasCrc });
          bytes[3] = channel << 6;
          frames.push(bytes);
        }
      }
    }
  }
  return frames;
}
