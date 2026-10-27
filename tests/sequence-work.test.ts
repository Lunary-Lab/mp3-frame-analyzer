import { expect, it, vi } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { decodeFrameHeader } from '../src/mp3/frame-header.js';
import {
  analyzeFreeFormatProbe,
  analyzeFreeFormatProbeSteps,
  runFreeFormatProbe,
} from '../src/mp3/free-format.js';
import { FREE_FORMAT_WORK_QUANTUM, Probe } from '../src/mp3/free-format-probe.js';
import { chunks } from './helpers/mp3-fixtures.js';

function denseHeaders(length: number, stride: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const count = Math.floor((length - 4) / stride) + 1;
  for (let index = 0; index < count; index++) {
    bytes.set([255, 251, index === count - 1 ? 4 : 0, 192], index * stride);
  }
  return bytes;
}

it('retains a full minimum-prefix-density probe without an arbitrary format rejection', async () => {
  const bytes = denseHeaders(8_647, 21);
  const header = decodeFrameHeader(bytes.subarray(0, 4));
  if (header.kind !== 'free-format') throw new Error('Invalid fixture');
  const sync = analyzeFreeFormatProbe(bytes, header, false, bytes.length + 1);
  expect(sync.bestBase).toBe(21);
  const steps = analyzeFreeFormatProbeSteps(bytes, header, false, bytes.length + 1);
  let yields = 0;
  let previousWork = 0;
  let step = steps.next();
  while (!step.done) {
    const work = step.value.candidates + step.value.followedFrames + step.value.metadataSteps;
    // One candidate can finish after a quantum; its advancing frame/tag walks
    // fit within a conservative two-window additional-work bound.
    expect(work - previousWork).toBeGreaterThanOrEqual(FREE_FORMAT_WORK_QUANTUM);
    expect(work - previousWork).toBeLessThanOrEqual(FREE_FORMAT_WORK_QUANTUM + 2 * bytes.length);
    previousWork = work;
    yields++;
    step = steps.next();
  }
  expect(step.value).toEqual(sync);
  expect(yields).toBeGreaterThan(0);
  expect(
    await runFreeFormatProbe(analyzeFreeFormatProbeSteps(bytes, header, false, bytes.length + 1)),
  ).toEqual(sync);
});

it('uses an exact monotonic scheduling quantum instead of refusing additional evidence', () => {
  expect(FREE_FORMAT_WORK_QUANTUM).toBe(2_048);
  const probe = new Probe(new Uint8Array(0), false, 1);
  for (let index = 0; index < FREE_FORMAT_WORK_QUANTUM - 1; index++) probe.visitCandidate();
  expect(probe.shouldYield()).toBe(false);
  probe.visitFrame();
  expect(probe.shouldYield()).toBe(true);
  expect(probe.shouldYield()).toBe(false);
  for (let index = 0; index < 600_001; index++) probe.visitCandidate();
  expect(probe.shouldYield()).toBe(true);
  expect(probe.work.candidates).toBe(602_048);
  expect(probe.work.followedFrames).toBe(1);
});

it('retains the actual malformed boundary and chunk independence after dense bounded inference', async () => {
  const bytes = new Uint8Array(8_648);
  for (let index = 0; index < 470; index++) {
    bytes.set([255, 251, index === 469 ? 4 : 0, 192], index * 18);
  }
  for (const sizes of [[1], [bytes.length]]) {
    await expect(countMp3Frames(chunks(bytes, sizes))).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: 8_460,
      message: 'Invalid MPEG-1 Layer III frame header',
    });
  }
});

it('distinguishes absence of any candidate from an actual ambiguous candidate set', async () => {
  const headerOnly = Uint8Array.from([255, 251, 4, 192]);
  await expect(countMp3Frames(chunks(headerOnly, [1]))).rejects.toMatchObject({
    kind: 'unsupported-format',
    offset: 0,
    message: 'Cannot infer a unique free-format MPEG frame size from consecutive headers',
  });
});

it('never probes metadata outside the fixed observation window', () => {
  const bytes = new Uint8Array(648);
  for (const offset of [0, 216, 432]) bytes.set([255, 251, 4, 192], offset);
  const header = decodeFrameHeader(bytes.subarray(0, 4));
  if (header.kind !== 'free-format') throw new Error('Invalid fixture');
  // Observational only: a coarse 432-byte candidate would next end at 864.
  // This is a supported resource invariant, not an exact incidental work count.
  const boundary = vi.spyOn(Probe.prototype, 'boundary');
  try {
    expect(analyzeFreeFormatProbe(bytes, header, true, bytes.length).bestBase).toBe(216);
    expect(boundary.mock.calls.length).toBeGreaterThan(0);
    expect(boundary.mock.calls.every(([offset]) => offset >= 0 && offset <= bytes.length)).toBe(
      true,
    );
  } finally {
    boundary.mockRestore();
  }
});

it('charges the bounded failed-envelope walk once and includes it in scheduling', () => {
  const bytes = new Uint8Array(70);
  // Four valid ten-byte tags, then an invalid fifth header. The failed
  // envelope must charge at least the five inspected headers, and at most
  // the six iterations (including termination) possible in this 50-byte tail.
  for (const offset of [20, 30, 40, 50, 60]) {
    bytes.set([73, 68, 51, offset === 60 ? 5 : 4, 0, 0, 0, 0, 0, 0], offset);
  }
  const probe = new Probe(bytes, true, bytes.length);
  for (let index = 0; index < FREE_FORMAT_WORK_QUANTUM - 5; index++) probe.visitCandidate();
  expect(probe.shouldYield()).toBe(false);
  expect(probe.boundary(20)).toBeUndefined();
  expect(probe.work.metadataSteps).toBeGreaterThanOrEqual(5);
  expect(probe.work.metadataSteps).toBeLessThanOrEqual(6);
  expect(probe.shouldYield()).toBe(true);
  const charged = probe.work.metadataSteps;
  expect(probe.boundary(20)).toBeUndefined();
  expect(probe.work.metadataSteps).toBe(charged);
  expect(probe.shouldYield()).toBe(false);
});

it('charges each validated tag and termination once without resetting the scheduling quantum', () => {
  const bytes = Uint8Array.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  const probe = new Probe(bytes, true, bytes.length);
  for (let index = 0; index < FREE_FORMAT_WORK_QUANTUM - 3; index++) probe.visitCandidate();
  expect(probe.shouldYield()).toBe(false);
  expect(probe.boundary(0)).toMatchObject({ offset: 20, tags: 2 });
  expect(probe.work.metadataSteps).toBe(3);
  expect(probe.shouldYield()).toBe(true);
  expect(probe.boundary(0)).toMatchObject({ offset: 20, tags: 2 });
  expect(probe.work.metadataSteps).toBe(3);
  expect(probe.shouldYield()).toBe(false);
});
