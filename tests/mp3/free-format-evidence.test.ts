import { expect, it, vi } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { decodeFrameHeader } from '../../src/mp3/frame-header.js';
import { analyzeFreeFormatProbe, analyzeFreeFormatProbeSteps } from '../../src/mp3/free-format.js';
import { FREE_FORMAT_WORK_QUANTUM, Probe } from '../../src/mp3/free-format-probe.js';
import { chunks } from '../helpers/mp3-fixtures.js';

// Original zero-main-data structural frames. Construction boundaries are an
// oracle only in the controls below; a credible competing layout must reject.
function freeFrames(span: number, count: number): Uint8Array {
  const bytes = new Uint8Array(span * count);
  for (let offset = 0; offset < bytes.length; offset += span) freeHeader(bytes, offset, 0);
  return bytes;
}
function freeHeader(bytes: Uint8Array, offset: number, rate: number): void {
  bytes.set([255, 251, rate << 2, 192], offset);
}
function indexedHeader(bytes: Uint8Array, offset: number, rate = 1, bitrate = 9): void {
  bytes.set([255, 251, (bitrate << 4) | (rate << 2), 192], offset);
}
function impossibleMainData(bytes: Uint8Array, offset: number): void {
  // Mono first part2_3_length=4095, main_data_begin=0. Its 512 data bytes
  // cannot fit a 384-byte indexed frame, even before its mandatory prefix.
  bytes[offset + 6]! |= 0x3f;
  bytes[offset + 7]! |= 0xfc;
}
function declareMonoMainData(bytes: Uint8Array, offset: number, bitsPerGranule: number): void {
  // Independent MPEG-1 mono side-information layout: two 59-bit granule
  // records start at bit 18, each beginning with a 12-bit part2_3_length.
  for (const record of [18, 77]) {
    for (let bit = 0; bit < 12; bit++) {
      if ((bitsPerGranule & (1 << (11 - bit))) === 0) continue;
      const position = (offset + 4) * 8 + record + bit;
      bytes[Math.floor(position / 8)]! |= 1 << (7 - (position % 8));
    }
  }
}
function tagToEnd(bytes: Uint8Array, offset: number, footer: boolean): void {
  const size = bytes.length - offset - (footer ? 20 : 10);
  const header = [
    73,
    68,
    51,
    footer ? 4 : 3,
    0,
    footer ? 16 : 0,
    size >>> 21,
    (size >>> 14) & 127,
    (size >>> 7) & 127,
    size & 127,
  ];
  bytes.set(header, offset);
  if (footer) bytes.set([51, 68, 73, ...header.slice(3)], bytes.length - 10);
}
const ambiguous = {
  kind: 'unsupported-format',
  offset: 0,
  message: 'Ambiguous free-format MPEG frame layout',
};
async function expectCount(bytes: Uint8Array, expected: number): Promise<void> {
  for (const size of [7, bytes.length]) {
    await expect(countMp3Frames(chunks(bytes, [size]))).resolves.toBe(expected);
  }
}
async function expectAmbiguous(bytes: Uint8Array): Promise<void> {
  for (const size of [7, bytes.length]) {
    await expect(countMp3Frames(chunks(bytes, [size]))).rejects.toMatchObject(ambiguous);
  }
}
function analyze(bytes: Uint8Array, ended: boolean) {
  const header = decodeFrameHeader(bytes.subarray(0, 4));
  if (header.kind !== 'free-format') throw new Error('Invalid fixture');
  return analyzeFreeFormatProbe(bytes, header, ended, bytes.length + Number(!ended));
}

it.each(['unclosed', 'footerless-tag'] as const)(
  'does not promote an EOF free suffix with an %s boundary into a competing layout',
  async (boundary) => {
    const bytes = freeFrames(1_000, 3);
    for (const offset of [216, 1_026, 1_836]) freeHeader(bytes, offset, 1);
    // The alternative's first 810-byte frame declares exactly its 789-byte
    // payload capacity: 2 * 3156 bits. This excludes the shorter 784-byte
    // bridge from 216 to the ordinary header at 1000 without assuming a
    // reservoir reset. All ordinary frame side information remains untouched.
    declareMonoMainData(bytes, 216, ((810 - 21) * 8) / 2);
    if (boundary === 'footerless-tag') tagToEnd(bytes, 2_646, false);
    for (const offset of [0, 1_000, 2_000]) {
      expect(bytes.subarray(offset + 4, offset + 21)).toEqual(new Uint8Array(17));
    }
    await expectCount(bytes, 3);
  },
);

it('does not promote an isolated indexed ancillary header to a closed EOF suffix', async () => {
  const bytes = freeFrames(1_000, 3);
  indexedHeader(bytes, 216);
  await expectCount(bytes, 3);
});

it('does not promote an isolated indexed ancillary header in an open probe', async () => {
  const bytes = freeFrames(1_000, 9);
  indexedHeader(bytes, 216);
  await expectCount(bytes, 9);
});

it('requires capacity even when an indexed suffix has an EOF metadata anchor', async () => {
  const bytes = freeFrames(1_000, 3);
  indexedHeader(bytes, 216);
  impossibleMainData(bytes, 216);
  tagToEnd(bytes, 600, true);
  await expectCount(bytes, 3);
});

it('does not propagate closure backwards through an impossible indexed frame', async () => {
  const bytes = freeFrames(1_000, 3);
  indexedHeader(bytes, 216);
  indexedHeader(bytes, 600);
  impossibleMainData(bytes, 600);
  await expectCount(bytes, 3);
});

it.each([1, 2])(
  'does not promote malformed metadata after %i indexed ancillary frames',
  async (count) => {
    const bytes = freeFrames(1_000, 3);
    for (let index = 0; index < count; index++) indexedHeader(bytes, 216 + 384 * index);
    // Version 5 cannot supply a supported metadata boundary.
    bytes.set([73, 68, 51, 5, 0, 0, 0, 0, 0, 0], 216 + 384 * count);
    await expectCount(bytes, 3);
  },
);

it('retains three-header evidence in an open indexed suffix despite an unusable later boundary', async () => {
  const bytes = freeFrames(432, 21);
  for (const offset of [200, 584, 968]) indexedHeader(bytes, offset);
  bytes.set([73, 68, 51, 5, 0, 0, 0, 0, 0, 0], 1_352);
  // This is the bounded open-probe policy, not a claim the alternate tail
  // decodes: three complete indexed spans forbid guessing the coarser count.
  await expectAmbiguous(bytes);
});

it('does not treat same-rate indexed-to-free switching as successor evidence', async () => {
  const bytes = freeFrames(432, 3);
  indexedHeader(bytes, 216);
  for (const offset of [600, 948]) freeHeader(bytes, offset, 1);
  await expectCount(bytes, 3);
});

it('retains one complete indexed EOF suffix as a genuine competing layout', async () => {
  const bytes = freeFrames(864, 1);
  indexedHeader(bytes, 288, 2);
  // Both 864 and 288+576 byte layouts have complete mandatory prefixes.
  await expectAmbiguous(bytes);
});

it.each([false, true])(
  'requires actual free-suffix closure after an indexed predecessor: impossible=%s',
  async (impossible) => {
    const bytes = freeFrames(432, 3);
    indexedHeader(bytes, 216);
    for (const offset of [600, 948]) freeHeader(bytes, offset, 2);
    if (impossible) {
      // Reserved big_values=511 cannot be a supported new sequence at any span.
      bytes[607] = 3;
      bytes[608] = 254;
      await expectCount(bytes, 3);
    } else {
      await expectAmbiguous(bytes);
    }
  },
);

it('charges each examined free candidate to observable cooperative work', () => {
  expect(analyze(freeFrames(21, 1), true)).toEqual({
    bestBase: 21,
    bestMatches: 1,
    tied: false,
    candidates: 1,
    followedFrames: 1,
    metadataSteps: 1,
  });
});

it('never inspects metadata beyond the probe for an incomplete indexed successor', () => {
  const bytes = freeFrames(216, 1);
  indexedHeader(bytes, 100, 2);
  const boundary = vi.spyOn(Probe.prototype, 'boundary');
  try {
    expect(analyze(bytes, true).bestBase).toBe(216);
    expect(boundary.mock.calls.length).toBeGreaterThan(0);
    expect(boundary.mock.calls.every(([offset]) => offset >= 0 && offset <= bytes.length)).toBe(
      true,
    );
  } finally {
    boundary.mockRestore();
  }
});

it('yields during reverse indexed-suffix analysis before repeated metadata work monopolizes a turn', () => {
  const bytes = freeFrames(8_647, 1);
  for (let offset = 2_010; offset < 3_450; offset += 30) indexedHeader(bytes, offset, 2, 14);
  for (let offset = 3_450; offset + 10 <= bytes.length; offset += 10) {
    bytes.set([73, 68, 51, 3, 0, 0, 0, 0, 0, 0], offset);
  }
  const first = decodeFrameHeader(bytes.subarray(0, 4));
  if (first.kind !== 'free-format') throw new Error('Invalid fixture');
  const step = analyzeFreeFormatProbeSteps(bytes, first, false, bytes.length + 1).next();
  expect(step.done).toBe(false);
  const work = step.value.candidates + step.value.followedFrames + step.value.metadataSteps;
  expect(work).toBeGreaterThanOrEqual(FREE_FORMAT_WORK_QUANTUM);
  expect(work).toBeLessThanOrEqual(FREE_FORMAT_WORK_QUANTUM + 2 * bytes.length);
});

it('evaluates successor existence once instead of ranking suffixes or re-evaluating the root', () => {
  const bytes = freeFrames(63, 1);
  freeHeader(bytes, 21, 1);
  freeHeader(bytes, 42, 1);
  // Reverse analysis needs one 21-byte witness at each of 42 and 21.
  // The root must still compare all three first spans: 21, 42 and 63.
  // Those five candidates follow 1+2+1+1+1 frames; only three distinct
  // boundaries require metadata observations. These are bounded-work
  // obligations of existence-only suffix evaluation, not a numeric-count oracle.
  expect(analyze(bytes, true)).toEqual({
    bestBase: 21,
    bestMatches: 1,
    tied: true,
    candidates: 5,
    followedFrames: 6,
    metadataSteps: 3,
  });
});
