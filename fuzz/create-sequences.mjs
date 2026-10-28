/** Original bounded sequence constructions, independent of the parser under test. */
const RATES = [44_100, 48_000, 32_000];
const FREE_KBPS = [7, 72, 128, 137, 320, 300];

function tag(body = Buffer.alloc(0), footer = false) {
  const header = Buffer.from([
    73,
    68,
    51,
    footer ? 4 : 3,
    0,
    footer ? 16 : 0,
    0,
    0,
    0,
    body.length,
  ]);
  if (!footer) return Buffer.concat([header, body]);
  const tail = Buffer.from(header);
  tail.set([51, 68, 73], 0);
  return Buffer.concat([header, body, tail]);
}

function setBits(bytes, bit, width, value) {
  for (let i = 0; i < width; i++) {
    const offset = bit + i;
    const mask = 1 << (7 - (offset % 8));
    const byte = Math.floor(offset / 8);
    bytes[byte] = (bytes[byte] & ~mask) | (((value >>> (width - i - 1)) & 1) * mask);
  }
}

function frame(at, serial, configuration, uncertain) {
  const { rate, free, kbps } = configuration;
  const padding = at(20 + serial * 3) & 1;
  const base = Math.floor((144_000 * (free ? kbps : 128)) / RATES[rate]);
  const length = base + padding;
  const crc = length >= 23 && Boolean(at(21 + serial * 3) & 1);
  const mode = length < 38 ? 3 : at(22 + serial * 3) % 4;
  const prefix = 4 + (crc ? 2 : 0) + (mode === 3 ? 17 : 32);
  const bytes = Buffer.alloc(length);
  for (let i = prefix; i < length; i++) bytes[i] = at(serial * 7 + i) & (uncertain ? 255 : 63);
  bytes.set([255, crc ? 250 : 251, (free ? 0 : 144) | (rate << 2) | (padding << 1), mode << 6]);
  return { bytes, prefix, rate, free, padding, crc, mode };
}

function impossibleAncillaryHeader(bytes, offset, rate, free) {
  if (offset + 21 > bytes.length) return;
  bytes.set([255, 251, (free ? 0 : 144) | (((rate + 1) % 3) << 2), 192], offset);
  // Exact-count cases use indexed decoys, never false same-rate free chains.
  // A header-like pattern is not new sequence evidence when big_values=511
  // exceeds the 288 pairs within a granule. This does not decode a frame.
  setBits(bytes, (offset + 4) * 8 + 18 + 12, 9, 511);
}

function configurations(at, uncertain) {
  let rate = at(3) % 3;
  return Array.from({ length: 2 + (at(2) % 3) }, (_, index) => {
    if (index > 0) rate = (rate + 1 + (at(index * 5 + 4) % 2)) % 3;
    return {
      rate,
      free: Boolean(at(index * 5 + 5) & 1),
      kbps: FREE_KBPS[at(index * 5 + 6) % FREE_KBPS.length],
      count: 1 + (at(index * 5 + 7) % (uncertain ? 7 : 3)),
    };
  });
}

function generated(at, uncertain) {
  const parts = [];
  const frameOffsets = [];
  const frameLengths = [];
  const configs = configurations(at, uncertain);
  let offset = 0;
  let serial = 0;
  for (const [index, config] of configs.entries()) {
    // Explicit metadata landmarks protect the exact-count domain's short
    // prefixes. The arbitrary domain also explores absent/intermediate tags.
    if (!uncertain || at(index + 8) & 1) {
      const metadata = tag(
        Buffer.from(Array.from({ length: at(index + 9) % 24 }, (_, j) => at(j))),
      );
      parts.push(metadata);
      offset += metadata.length;
    }
    for (let i = 0; i < config.count; i++) {
      const physical = frame(at, serial++, config, uncertain);
      if (at(index + 10) & 1) {
        impossibleAncillaryHeader(physical.bytes, physical.prefix + 1, config.rate, uncertain);
      }
      parts.push(physical.bytes);
      frameOffsets.push(offset);
      frameLengths.push(physical.bytes.length);
      offset += physical.bytes.length;
    }
  }
  if (at(11) & 1) parts.push(tag(Buffer.alloc(0), true));
  return {
    bytes: Buffer.concat(parts),
    configurations: configs,
    frameOffsets,
    frameLengths,
    expectation: uncertain ? { kind: 'structural' } : { kind: 'count', count: serial },
  };
}

function silent(base, rate, count) {
  return Array.from({ length: count }, () => {
    const bytes = Buffer.alloc(base);
    bytes.set([255, 251, rate << 2, 192]);
    return bytes;
  });
}

function ambiguous(at) {
  const longer = Boolean(at(1) & 1);
  const parts = longer
    ? [...silent(324, 2, 7), ...silent(216, 1, 7)]
    : [...silent(216, 1, 1), ...silent(324, 2, 2)];
  const alternative = longer ? [0, 972, 1944, 2916, 3132, 3348, 3564, 3780] : [0, 864];
  return {
    bytes: Buffer.concat(parts),
    configurations: [],
    frameOffsets: parts.map((_, index) =>
      parts.slice(0, index).reduce((n, part) => n + part.length, 0),
    ),
    frameLengths: parts.map((part) => part.length),
    alternative,
    expectation: { kind: 'ambiguous' },
  };
}

function denseAncillary() {
  const parts = silent(900, 1, 3);
  for (const bytes of parts) {
    for (let offset = 21; offset + 4 <= bytes.length; offset += 3)
      bytes.set([255, 251, 0, 192], offset);
  }
  return {
    bytes: Buffer.concat(parts),
    configurations: [{ rate: 1, free: true, kbps: 300, count: 3 }],
    frameOffsets: [0, 900, 1800],
    frameLengths: [900, 900, 900],
    expectation: { kind: 'count', count: 3 },
  };
}

/**
 * Four explicit domains: metadata-anchored counts; arbitrary payload/layout
 * chunk invariance (no guessed count); proven ambiguity; dense ancillary control.
 * At most 28 frames of 1441 bytes, plus bounded tags. No source/parser imports.
 */
export function createSequenceMp3(input) {
  const data = Buffer.from(input);
  const at = (index) => (data.length ? data[index % data.length] : 0);
  switch (at(0) % 4) {
    case 0:
      return generated(at, false);
    case 1:
      return generated(at, true);
    case 2:
      return ambiguous(at);
    default:
      return denseAncillary();
  }
}
