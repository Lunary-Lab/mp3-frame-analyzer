/** Fields every MPEG-1 Audio Layer III frame header carries: ISO/IEC 11172-3. */
interface HeaderFields {
  /** 0, 1 or 2 for 44.1, 48 or 32 kHz. */
  readonly sampleRateIndex: number;
  readonly padding: 0 | 1;
  readonly hasCrc: boolean;
  /** Single-channel mode, which places conventional Xing/Info metadata earlier in the frame. */
  readonly mono: boolean;
}

/** A frame whose bitrate index gives its length through the bitrate table. */
export interface IndexedFrameHeader extends HeaderFields {
  readonly kind: 'indexed';
  readonly length: number;
}

/** Free-format is a valid subtype whose frame span is not in the table. */
export interface FreeFormatFrameHeader extends HeaderFields {
  readonly kind: 'free-format';
}

export type FrameHeader = IndexedFrameHeader | FreeFormatFrameHeader;

/**
 * `unsupported` is a valid MPEG sync for another version or layer; `invalid`
 * is anything else, including MPEG-1 Layer III with reserved field values.
 */
export type DecodedHeader =
  FrameHeader | { readonly kind: 'unsupported' } | { readonly kind: 'invalid' };

const BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;
const SAMPLE_RATES_HZ = [44_100, 48_000, 32_000] as const;
const UNSUPPORTED: DecodedHeader = { kind: 'unsupported' };
const INVALID: DecodedHeader = { kind: 'invalid' };

/** Classify the four header bytes of a frame candidate. `bytes` must hold at least four bytes. */
export function decodeFrameHeader(bytes: Uint8Array): DecodedHeader {
  // Unsigned bitwise arithmetic avoids signed 32-bit interpretation issues.
  const word = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;

  if (word >>> 21 !== 0x7ff) return INVALID; // 11-bit sync marker
  const version = (word >>> 19) & 0b11;
  const layer = (word >>> 17) & 0b11;
  if (version !== 0b11 || layer !== 0b01) return UNSUPPORTED; // MPEG-1 Layer III only

  const bitrateIndex = (word >>> 12) & 0b1111;
  const sampleRateIndex = (word >>> 10) & 0b11;
  if (bitrateIndex === 0b1111 || sampleRateIndex === 0b11) return INVALID;
  if ((word & 0b11) === 0b10) return INVALID; // Reserved emphasis occupies bits 1..0

  const fields: HeaderFields = {
    sampleRateIndex,
    padding: ((word >>> 9) & 1) as 0 | 1,
    hasCrc: ((word >>> 16) & 1) === 0,
    mono: ((word >>> 6) & 0b11) === 0b11,
  };
  if (bitrateIndex === 0) return { kind: 'free-format', ...fields };
  const length =
    Math.floor((144_000 * BITRATES_KBPS[bitrateIndex]!) / SAMPLE_RATES_HZ[sampleRateIndex]!) +
    fields.padding;
  return { kind: 'indexed', length, ...fields };
}
