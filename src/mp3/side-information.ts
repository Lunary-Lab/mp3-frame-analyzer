import type { FrameHeader } from './frame-header.js';

type TargetHeader = Extract<FrameHeader, { kind: 'indexed' | 'free-format' }>;

// ISO/IEC 11172-3:1993, 2.4.2.7: MPEG-1 scalefac_compress to slen1/slen2.
const SLEN1 = [0, 0, 0, 0, 3, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4] as const;
const SLEN2 = [0, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 2, 3] as const;

function bits(bytes: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let bit = offset; bit < offset + width; bit++) {
    value = value * 2 + ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
  }
  return value;
}

function scaleBits(bytes: Uint8Array, record: number, scfsi: number): number {
  const compression = bits(bytes, record + 29, 4);
  const slen1 = SLEN1[compression]!;
  const slen2 = SLEN2[compression]!;
  const switched = bits(bytes, record + 33, 1) === 1;
  if (switched && bits(bytes, record + 34, 2) === 2) {
    // Short blocks: 12 bands in each of three windows. Mixed blocks replace
    // their first three short bands by eight long bands (2.4.3.4.5).
    const mixed = bits(bytes, record + 36, 1) === 1;
    return (mixed ? 17 : 18) * slen1 + 18 * slen2;
  }
  // Four long-block groups contain 6, 5, 5 and 5 scalefactors. Grant every
  // signalled second-granule reuse; this is a necessary bound, not validation
  // that the previous granule actually supplies valid reusable values.
  return (
    (scfsi & 8 ? 0 : 6 * slen1) +
    (scfsi & 4 ? 0 : 5 * slen1) +
    (scfsi & 2 ? 0 : 5 * slen2) +
    (scfsi & 1 ? 0 : 5 * slen2)
  );
}

function recordMayFit(bytes: Uint8Array, record: number, scfsi: number): boolean {
  const pairs = bits(bytes, record + 12, 9);
  if (pairs > 288) return false;
  const switched = bits(bytes, record + 33, 1) === 1;
  if (switched && bits(bytes, record + 34, 2) === 0) return false;
  // The first pair always belongs to region zero. Undefined tables 4 and 14
  // cannot code it; do not reject unused selections or pretend to decode data.
  const firstTable = bits(bytes, record + (switched ? 37 : 34), 5);
  if (pairs > 0 && (firstTable === 4 || firstTable === 14)) return false;
  return bits(bytes, record, 12) >= scaleBits(bytes, record, scfsi);
}

/** Necessary new-sequence evidence only; not a decoder or conformance validator. */
export function minimumFrameDataSpan(
  bytes: Uint8Array,
  start: number,
  header: TargetHeader,
): number | undefined {
  const sideStart = start + 4 + (header.hasCrc ? 2 : 0);
  const prefix = sideStart - start + (header.mono ? 17 : 32);
  if (start + prefix > bytes.length) return undefined;
  const side = sideStart * 8;
  const channels = header.mono ? 1 : 2;
  const firstRecord = header.mono ? 18 : 20;
  const firstScfsi = firstRecord - channels * 4;
  let dataBits = 0;
  for (let index = 0; index < channels * 2; index++) {
    const record = side + firstRecord + index * 59;
    const scfsi = index < channels ? 0 : bits(bytes, side + firstScfsi + (index % channels) * 4, 4);
    if (!recordMayFit(bytes, record, scfsi)) return Infinity;
    dataBits += bits(bytes, record, 12);
  }
  return prefix + Math.ceil(dataBits / 8) - bits(bytes, side, 9);
}
