/** Small, deterministic MPEG fixtures; never relies on the parser under test. */
const BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
] as const;
const SAMPLE_RATES = [44_100, 48_000, 32_000] as const;

export interface FrameOptions {
  bitrateIndex?: number;
  sampleRateIndex?: number;
  padding?: 0 | 1;
  hasCrc?: boolean;
  seed?: number;
}

export function frame(options: FrameOptions = {}): Buffer {
  const { bitrateIndex = 9, sampleRateIndex = 0, padding = 0, hasCrc = false, seed = 0 } = options;
  const bitrate = BITRATES[bitrateIndex];
  const rate = SAMPLE_RATES[sampleRateIndex];
  if (bitrate === undefined || bitrate === 0 || rate === undefined) {
    throw new Error('Fixture requires valid MPEG-1 L3 indices');
  }
  const length = Math.floor((144_000 * bitrate) / rate) + padding;
  const data = Buffer.alloc(length, seed);
  const header =
    (0x7ff << 21) |
    (0b11 << 19) |
    (0b01 << 17) |
    ((hasCrc ? 0 : 1) << 16) |
    (bitrateIndex << 12) |
    (sampleRateIndex << 10) |
    (padding << 9);
  data.writeUInt32BE(header >>> 0, 0);
  return data;
}

export function synchsafe(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1 << 28) {
    throw new Error('Invalid synchsafe fixture size');
  }
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

export function id3v2(body: Uint8Array, version: 2 | 3 | 4 = 4, footer = false): Buffer {
  if (footer && version !== 4) throw new Error('Footer requires ID3v2.4');
  const flags = footer ? 0x10 : 0;
  const header = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, version, 0, flags]),
    synchsafe(body.length),
  ]);
  if (!footer) return Buffer.concat([header, body]);
  const footerBytes = Buffer.from(header);
  footerBytes.set([0x33, 0x44, 0x49], 0);
  return Buffer.concat([header, body, footerBytes]);
}

export function id3v1(): Buffer {
  const data = Buffer.alloc(128, 0);
  data.write('TAG', 0, 'ascii');
  return data;
}

export function mp3(frames: readonly Buffer[], intro?: Buffer, tail?: Buffer): Buffer {
  return Buffer.concat([intro ?? Buffer.alloc(0), ...frames, tail ?? Buffer.alloc(0)]);
}

export async function* chunks(
  bytes: Uint8Array,
  sizes: readonly number[],
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = Math.max(1, sizes[index % sizes.length] ?? 1);
    const end = Math.min(bytes.length, offset + size);
    yield bytes.subarray(offset, end);
    offset = end;
    index++;
  }
}

export function multipartBody(
  bytes: Uint8Array,
  { field = 'file', mime = 'audio/mpeg', filename = 'test.mp3' } = {},
): { contentType: string; payload: Buffer } {
  const boundary = 'assessment-test-boundary-123';
  const before = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const after = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([before, bytes, after]),
  };
}
