import { describe, expect, it, vi } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { decodeFrameHeader } from '../../src/mp3/frame-header.js';
import { ClosedShortCandidates, Probe } from '../../src/mp3/free-format-probe.js';
import { analyzeFreeFormatProbe, analyzeFreeFormatProbeSteps } from '../../src/mp3/free-format.js';
import * as sideInformation from '../../src/mp3/side-information.js';
import { chunks, id3v2 } from '../helpers/mp3-fixtures.js';

function freeFrame(length = 100): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([255, 251, 0, 192]);
  return bytes;
}

it.each([1, 2, 3, 4])('defers only short walks, given a complete %i-frame walk', (count) => {
  const bytes = Buffer.concat(Array.from({ length: count }, () => freeFrame()));
  const header = decodeFrameHeader(bytes.subarray(0, 4));
  if (header.kind !== 'free-format') throw new Error('Invalid fixture');
  const shorts = new ClosedShortCandidates(new Probe(bytes, true, bytes.length), header, true);
  shorts.observe({
    base: 100,
    matches: count,
    anchored: true,
    metadataMatches: 0,
    transition: false,
    closed: true,
    frames: Array.from({ length: count }, (_, index) => ({
      start: index * 100,
      end: (index + 1) * 100,
      header,
    })),
  });
  // Long walks contribute bounded header evidence, but must not be retained
  // as deferred frame records by the short-candidate component.
  expect([...shorts.candidates()].map((candidate) => candidate.matches)).toEqual(
    count <= 2 ? [count] : [],
  );
});

describe('short-probe metadata evidence across nonzero frame starts', () => {
  it('retains a plausible ID3 prefix after an earlier boundary-aligned ID3 tag', async () => {
    const second = freeFrame();
    const tag = id3v2(Buffer.alloc(0));
    const control = Buffer.concat([freeFrame(), tag, second]);
    second.set(tag, 50);
    const ambiguous = Buffer.concat([freeFrame(), tag, second]);
    for (const sizes of [[1], [ambiguous.length]]) {
      expect(await countMp3Frames(chunks(control, sizes))).toBe(2);
      await expect(countMp3Frames(chunks(ambiguous, sizes))).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: 0,
      });
    }
  });

  it('retains a plausible tail after an earlier TAG too far from EOF to be a tail', async () => {
    const first = freeFrame();
    first.write('TAG', 50, 'ascii');
    const second = freeFrame();
    const control = Buffer.concat([first, second]);
    second.write('TAG', 50, 'ascii');
    const ambiguous = Buffer.concat([first, second]);
    for (const sizes of [[1], [ambiguous.length]]) {
      expect(await countMp3Frames(chunks(control, sizes))).toBe(2);
      await expect(countMp3Frames(chunks(ambiguous, sizes))).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: 0,
      });
    }
  });

  it('does not treat TAG overlapping a later MPEG header as payload metadata', async () => {
    const second = freeFrame();
    // Joint stereo, valid flags/emphasis; the final header byte is ASCII T.
    // This is a structural fixture, not a claim of decodable side information.
    second.set([0x54, 0x41, 0x47], 3);
    const bytes = Buffer.concat([freeFrame(), second]);
    for (const sizes of [[1], [bytes.length]]) {
      expect(await countMp3Frames(chunks(bytes, sizes))).toBe(2);
    }
  });
});

describe('necessary frame capacity is relative to the proposed frame start', () => {
  it('does not borrow mandatory prefix bytes at a nonzero offset', () => {
    const start = 100;
    const bytes = Buffer.concat([Buffer.alloc(start), freeFrame()]);
    // The nine-bit reservoir pointer grants 511 prior main-data bytes, never
    // bytes of this frame\'s mandatory header or side-information prefix.
    bytes.set([0xff, 0x80], start + 4);
    const header = decodeFrameHeader(bytes.subarray(start, start + 4));
    if (header.kind !== 'free-format') throw new Error('Invalid fixture');
    const probe = new Probe(bytes, true, bytes.length);
    expect(probe.frameMayFit(start, start + 20, header)).toBe(false);
    expect(probe.frameMayFit(start, start + 21, header)).toBe(true);
  });

  it('checks declared main-data capacity and caches the unchanged side fields', () => {
    const start = 100;
    const bytes = Buffer.concat([Buffer.alloc(start), freeFrame()]);
    // Mono granule one starts 18 bits into side information. Set its 12-bit
    // part2_3_length to eight: one byte beyond the mandatory 21-byte prefix.
    bytes[start + 7] = 0x20;
    const header = decodeFrameHeader(bytes.subarray(start, start + 4));
    if (header.kind !== 'free-format') throw new Error('Invalid fixture');
    const observe = vi.spyOn(sideInformation, 'minimumFrameDataSpan');
    try {
      const probe = new Probe(bytes, true, bytes.length);
      expect(probe.frameMayFit(start, start + 21, header)).toBe(false);
      expect(probe.frameMayFit(start, start + 22, header)).toBe(true);
      expect(probe.frameMayFit(start, start + 21, header)).toBe(false);
      // Candidate endpoints vary, but one immutable side-field observation
      // per offset is the documented fixed-window cache/resource contract.
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {
      observe.mockRestore();
    }
  });
});

describe('probe work is driven by supported boundary evidence', () => {
  it('bounds work and fallback allocations with an unproved successor edge', () => {
    const bytes = Buffer.alloc(8_647);
    bytes.set([255, 251, 0, 192]);
    bytes.set([255, 251, 4, 192], 8_200);
    const first = decodeFrameHeader(bytes.subarray(0, 4));
    if (first.kind !== 'free-format') throw new Error('Invalid fixture');
    let allocations = 0;
    const observed = new Proxy(Uint16Array, {
      construct(target, args) {
        allocations++;
        return Reflect.construct(target, args) as Uint16Array;
      },
    });
    vi.stubGlobal('Uint16Array', observed);
    try {
      // The changed-rate suffix is inside a full, open production-size probe.
      // Neither header has a later real landmark within its allowed span.
      const result = analyzeFreeFormatProbe(bytes, first, false, bytes.length + 1);
      expect(result.bestMatches).toBe(0);
      expect(result.candidates).toBe(0);
      expect(result.followedFrames).toBe(0);
      expect(result.metadataSteps).toBe(0);
      // Five fixed observation indexes plus at most one root fallback index;
      // failed suffixes must never each allocate a window-sized prefix.
      expect(allocations).toBeLessThanOrEqual(6);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not turn non-target ancillary sync markers into extra candidate walks or yields', async () => {
    const clean = freeFrame(1_044);
    const first = decodeFrameHeader(clean.subarray(0, 4));
    if (first.kind !== 'free-format') throw new Error('Invalid fixture');
    const baseline = analyzeFreeFormatProbeSteps(clean, first, true, clean.length).next();
    expect(baseline.done).toBe(true);
    // Reserved bitrate, MPEG-2, and incomplete sync are all non-target data.
    // Keep the mandatory prefix zero: the changed bytes are ancillary only.
    for (const marker of [
      [255, 251, 240, 192],
      [255, 243, 0, 192],
      [255, 0, 0, 0],
    ]) {
      const noisy = Buffer.from(clean);
      for (let offset = 24; offset + 4 <= noisy.length; offset += 4) noisy.set(marker, offset);
      expect(analyzeFreeFormatProbeSteps(noisy, first, true, noisy.length).next()).toEqual(
        baseline,
      );
      expect(await countMp3Frames(chunks(noisy, [1, 97]))).toBe(1);
    }
  });
});
