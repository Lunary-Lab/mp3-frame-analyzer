/** MPEG-1 Audio Layer III frame header: ISO/IEC 11172-3. */
export interface FrameHeader {
  readonly length: number;
  readonly bitrateKbps: number;
  readonly sampleRateHz: number;
  readonly padding: 0 | 1;
  readonly hasCrc: boolean;
}

const BITRATES_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
] as const;
const SAMPLE_RATES_HZ = [44_100, 48_000, 32_000, 0] as const;

/** Returns null for any header outside the supported MPEG-1 Layer III subset. */
export function parseFrameHeader(bytes: Uint8Array): FrameHeader | null {
  if (bytes.length < 4) return null;

  // Unsigned bitwise arithmetic avoids signed 32-bit interpretation issues.
  const word =
    ((bytes[0]! << 24) |
      (bytes[1]! << 16) |
      (bytes[2]! << 8) |
      bytes[3]!) >>>
    0;

  if ((word >>> 21) !== 0x7ff) return null; // 11-bit sync marker
  if (((word >>> 19) & 0b11) !== 0b11) return null; // MPEG-1 only
  if (((word >>> 17) & 0b11) !== 0b01) return null; // Layer III only

  const bitrateKbps = BITRATES_KBPS[(word >>> 12) & 0b1111]!;
  const sampleRateHz = SAMPLE_RATES_HZ[(word >>> 10) & 0b11]!;
  if (bitrateKbps === 0 || sampleRateHz === 0) return null;
  if (((word >>> 4) & 0b11) === 0b10) return null; // Reserved emphasis

  const padding = ((word >>> 9) & 1) as 0 | 1;
  return {
    length: Math.floor((144_000 * bitrateKbps) / sampleRateHz) + padding,
    bitrateKbps,
    sampleRateHz,
    padding,
    hasCrc: ((word >>> 16) & 1) === 0,
  };
}

/** Distinguish an unsupported MPEG version/layer from arbitrary invalid data. */
export function looksLikeUnsupportedMpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const first = bytes[0]!;
  const second = bytes[1]!;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return false;
  const version = (second >>> 3) & 0b11;
  const layer = (second >>> 1) & 0b11;
  return version !== 0b11 || layer !== 0b01;
}
