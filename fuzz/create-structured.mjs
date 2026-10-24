/**
 * Independent construction oracle for MPEG-1 Layer III byte streams.
 * The parser under test is never consulted when deriving the frame count.
 * Input bytes control frame count, bitrate, sample rate, padding, CRC, payload,
 * initial ID3 metadata and optional trailing ID3v1 metadata.
 */
const BITRATE_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const SAMPLE_RATE_HZ = [44_100, 48_000, 32_000];

function synchsafe(value) {
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function id3(body, version, footer) {
  const flags = version === 4 && footer ? 0x10 : 0;
  const header = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, version, 0, flags]),
    synchsafe(body.length),
  ]);
  if (!flags) return Buffer.concat([header, body]);
  const tail = Buffer.from(header);
  tail.set([0x33, 0x44, 0x49], 0);
  return Buffer.concat([header, body, tail]);
}

export function createStructuredMp3(input) {
  const data = Buffer.from(input);
  const at = (index) => (data.length ? data[index % data.length] : 0);
  const frames = [];
  const frameCount = 1 + (at(0) % 24);
  const flags = at(1);
  const intro = [];
  if ((flags & 1) !== 0) {
    const numberOfTags = 1 + (at(2) % 3);
    for (let tag = 0; tag < numberOfTags; tag++) {
      const length = at(3 + tag) % 48;
      const body = Buffer.alloc(length);
      for (let j = 0; j < length; j++) body[j] = at(5 + tag + j);
      const version = 2 + (at(8 + tag) % 3);
      intro.push(id3(body, version, Boolean(flags & 2)));
    }
  }
  for (let i = 0; i < frameCount; i++) {
    const bits = at(9 + 5 * i);
    const bitrateIndex = 1 + (bits % 14);
    const sampleRateIndex = at(10 + 5 * i) % 3;
    const padding = at(11 + 5 * i) & 1;
    const hasCrc = Boolean(at(12 + 5 * i) & 1);
    const bitrate = BITRATE_KBPS[bitrateIndex];
    const sampleRate = SAMPLE_RATE_HZ[sampleRateIndex];
    const length = Math.floor((144000 * bitrate) / sampleRate) + padding;
    const block = Buffer.alloc(length);
    const emphasis = [0, 1, 3][at(13 + 5 * i) % 3];
    const header =
      ((0x7ff << 21) |
        (3 << 19) |
        (1 << 17) |
        ((hasCrc ? 0 : 1) << 16) |
        (bitrateIndex << 12) |
        (sampleRateIndex << 10) |
        (padding << 9) |
        ((at(14 + 5 * i) % 4) << 6) |
        emphasis) >>>
      0;
    for (let j = 0; j < length; j++) block[j] = at(i * 7 + j + 16);
    block.writeUInt32BE(header, 0);
    frames.push(block);
  }
  const tail = [];
  if ((flags & 4) !== 0) {
    const id3v1 = Buffer.alloc(128, 0);
    id3v1.write("TAG", 0, "ascii");
    tail.push(id3v1);
  }
  return {
    bytes: Buffer.concat([...intro, ...frames, ...tail]),
    expectedCount: frameCount,
  };
}
