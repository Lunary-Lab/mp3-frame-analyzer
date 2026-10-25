import { frame, id3v1, id3v2 } from './mp3-fixtures.js';

/** Source-written structural fixtures, not encoded/CRC-verified audio.
 * Xing field order/masks: lameproject/lame libmp3lame/VbrTag.h and VbrTag.c.
 * VBRI fixed fields: FFmpeg libavformat/mp3dec.c; TOC: GStreamer
 * subprojects/gst-plugins-good/gst/audioparsers/gstmpegaudioparse.c.
 * These helpers do not import the production decoder or recognizer.
 */
export interface Layout {
  readonly channel: 0 | 1 | 2 | 3;
  readonly crc: boolean;
  readonly padding: 0 | 1;
  /** LAME's protected tag is unshifted; +2 is existing compatibility policy. */
  readonly crcShift: 0 | 2;
}

export const layouts: readonly Layout[] = ([0, 1, 2, 3] as const).flatMap((channel) =>
  ([0, 1] as const).flatMap((padding) => [
    { channel, padding, crc: false, crcShift: 0 },
    { channel, padding, crc: true, crcShift: 0 },
    { channel, padding, crc: true, crcShift: 2 },
  ]),
);

export function indexedFrame(layout: Layout): Buffer {
  const bytes = frame({ hasCrc: layout.crc, padding: layout.padding });
  bytes[3] = (layout.channel << 6) | 0x04;
  // Nonzero side information catches accidental reads at the wrong offset.
  bytes.fill(0x25, 4, 4 + (layout.crc ? 2 : 0) + (layout.channel === 3 ? 17 : 32));
  return bytes;
}

export function xingPosition(layout: Layout): number {
  return (layout.channel === 3 ? 21 : 36) + layout.crcShift;
}

export function xingFields(flags: number): Buffer {
  const fields: Buffer[] = [];
  if (flags & 1) fields.push(Buffer.from([0x01, 0x23, 0x45, 0x67]));
  if (flags & 2) fields.push(Buffer.from([0x12, 0x34, 0x56, 0x78]));
  if (flags & 4) fields.push(Buffer.from(Array.from({ length: 100 }, (_, i) => i * 2)));
  if (flags & 8) fields.push(Buffer.from([0, 0, 0, 75]));
  return Buffer.concat(fields);
}

export function xingFrame(kind: 'Xing' | 'Info', flags: number, layout: Layout): Buffer {
  const bytes = indexedFrame(layout);
  const position = xingPosition(layout);
  bytes.write(kind, position, 'ascii');
  bytes.writeUInt32BE(flags, position + 4);
  xingFields(flags).copy(bytes, position + 8);
  return bytes;
}

export function vbriFrame(layout: Layout, width: 1 | 2 | 3 | 4, entries = 3): Buffer {
  const bytes = indexedFrame(layout);
  bytes.write('VBRI', 36, 'ascii');
  bytes.writeUInt16BE(1, 40);
  bytes.writeUInt16BE(576, 42);
  bytes.writeUInt16BE(75, 44);
  bytes.writeUInt32BE(0x12345678, 46);
  bytes.writeUInt32BE(0x01234567, 50);
  bytes.writeUInt16BE(entries, 54);
  bytes.writeUInt16BE(1, 56);
  bytes.writeUInt16BE(width, 58);
  bytes.writeUInt16BE(1, 60);
  for (let entry = 0; entry < entries; entry++) {
    bytes.writeUIntBE(20 + entry, 62 + entry * width, width);
  }
  return bytes;
}

/** Real ID3 text-record envelopes, rather than a tag containing only padding. */
export function titleTag(version: 2 | 3 | 4, footer = false): Buffer {
  const title =
    version === 2
      ? Buffer.from([0x54, 0x54, 0x32, 0, 0, 2, 0, 0x41])
      : Buffer.from([0x54, 0x49, 0x54, 0x32, 0, 0, 0, 2, 0, 0, 0, 0x41]);
  return id3v2(title, version, footer);
}

export function id3v11(): Buffer {
  const bytes = id3v1();
  bytes.write('Fixture', 3, 'ascii');
  bytes[125] = 0;
  bytes[126] = 7;
  return bytes;
}

/** ID3v2.4 §5 paired layout: SEEK is relative to the end of the leading tag. */
export function withPairedTags(audio: Buffer): Buffer {
  const title = titleTag(4).subarray(10);
  const seek = Buffer.from([0x53, 0x45, 0x45, 0x4b, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0]);
  seek.writeUInt32BE(audio.length, 10);
  const leading = id3v2(Buffer.concat([title, seek]), 4);
  return Buffer.concat([leading, audio, titleTag(4, true), id3v11()]);
}
