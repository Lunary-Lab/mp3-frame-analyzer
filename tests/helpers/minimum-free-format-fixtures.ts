/** Original fixtures derived from ISO/IEC 11172-3:1993 §§2.4.1.3/.4/.7 and 2.4.3.1. */
export function minimumFreeFrame(
  base: number,
  { padding = 0, crc = false, mode = 3, rate = 1 } = {},
): Buffer {
  const frame = Buffer.alloc(base + padding);
  frame.set([0xff, crc ? 0xfa : 0xfb, (rate << 2) | (padding << 1), mode << 6]);
  const sideBytes = mode === 3 ? 17 : 32;
  if (crc && frame.length >= 6 + sideBytes) {
    // Only fixture generation calculates CRC; production remains a structural counter.
    const protectedBytes = Buffer.concat([frame.subarray(2, 4), frame.subarray(6, 6 + sideBytes)]);
    let remainder = 0xffff;
    for (const byte of protectedBytes) {
      for (let bit = 7; bit >= 0; bit--) {
        const feedback = (remainder >>> 15) ^ ((byte >>> bit) & 1);
        remainder = (remainder << 1) & 0xffff;
        if (feedback) remainder ^= 0x8005;
      }
    }
    frame.writeUInt16BE(remainder, 4);
  }
  return frame;
}
