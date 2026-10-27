import { terminalCancellation } from './helpers/terminal-cancellation.js';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks } from './helpers/mp3-fixtures.js';

/** Original ancillary patterns, not encoded audio or a universal uniqueness oracle. */
function denseAncillary(): Uint8Array {
  const bytes = new Uint8Array(2_700);
  for (let offset = 0; offset < bytes.length; offset += 900) {
    bytes.set([255, 251, 4, 192], offset);
    for (let position = 21; position + 4 <= 900; position += 3) {
      bytes.set([255, 251, 0, 192], offset + position);
    }
  }
  return bytes;
}

it('preserves three ordinary 300-kbps free frames with dense ancillary header patterns', async () => {
  const bytes = denseAncillary();
  for (const sizes of [[1], [257], [bytes.length]]) {
    expect(await countMp3Frames(chunks(bytes, sizes))).toBe(3);
  }
});

it('lets a queued event-loop turn run before a substantial inference finishes', async () => {
  let ran = false;
  const queued = nextTurn().then(() => {
    ran = true;
  });
  try {
    await countMp3Frames(chunks(denseAncillary(), [2_700]));
  } catch {
    // The scheduling assertion also distinguishes the previous synchronous refusal.
  }
  expect(ran).toBe(true);
  await queued;
});

it('honors cancellation during buffered inference and closes the iterator exactly once', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller stopped inference');
  let returned = 0;
  let reads = 0;
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: reads++ > 0, value: denseAncillary() }),
        return: async () => {
          returned++;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const queued = nextTurn().then(() => controller.abort(reason));
  const options = { includeVbrHeaderFrame: true, signal: controller.signal };
  await expect(countMp3Frames(input, options)).rejects.toBe(reason);
  // EOF was already observed, so there is no live upstream iterator left to return.
  expect(returned).toBe(0);
  expect(reads).toBe(2);
  await queued;
});

it('honors already-aborted cancellation without reading and closes a live iterator once', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller already stopped');
  controller.abort(reason);
  let returned = 0;
  let reads = 0;
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          reads++;
          return { done: false as const, value: denseAncillary() };
        },
        return: async () => {
          returned++;
          throw new Error('Cleanup must not replace cancellation');
        },
      };
    },
  };
  const options = { includeVbrHeaderFrame: true, signal: controller.signal };
  await expect(countMp3Frames(input, options)).rejects.toBe(reason);
  expect(reads).toBe(0);
  expect(returned).toBe(1);
});

it('cancels an open buffered probe without pulling another chunk and closes it once', async () => {
  const controller = new AbortController();
  const reason = new Error('Client disconnected during discovery');
  const bytes = new Uint8Array(8_648);
  for (let offset = 0; offset + 4 <= bytes.length; offset += 21) {
    bytes.set([255, 251, offset > 8_600 ? 4 : 0, 192], offset);
  }
  let pulled = 0;
  let closed = 0;
  async function* input() {
    try {
      pulled++;
      yield bytes;
      pulled++;
      yield new Uint8Array(1_000_000);
    } finally {
      closed++;
    }
  }
  const queued = nextTurn().then(() => controller.abort(reason));
  await expect(countMp3Frames(input(), { signal: controller.signal })).rejects.toBe(reason);
  expect(pulled).toBe(1);
  expect(closed).toBe(1);
  await queued;
});

it('documents why the dense ancillary continuations are impossible without assuming reservoir resets', () => {
  const bytes = denseAncillary();
  function field(start: number, bit: number, width: number): number {
    const binary = [...bytes.subarray(start + 4, start + 21)]
      .map((value) => value.toString(2).padStart(8, '0'))
      .join('');
    return Number.parseInt(binary.slice(bit, bit + width), 2);
  }
  // False layout 0,24,693,1362,2031,2700: its first successor requests
  // 502 backward bytes but the proposed first frame provides only three.
  expect(field(24, 0, 9)).toBe(502);
  expect(24 - 21).toBe(3);
  // Later 0,891,1194,1497,1800,2700 has enough preceding bytes; do not
  // invent a reset. Its records instead exceed the 576-value spectral domain.
  expect(891 - 21).toBeGreaterThanOrEqual(field(891, 0, 9));
  for (const offset of [1194, 1497]) {
    expect(field(offset, 18 + 12, 9)).toBe(384);
    expect(field(offset, 18 + 59 + 12, 9)).toBe(511);
  }
});

it('retains the observed malformed boundary before a terminal-EOF cancellation turn', async () => {
  // This fixed malformed probe completes bounded inference without a real turn.
  // Probing beyond its window adds work that yields and wrongly substitutes
  // caller cancellation for the already-observable truncated-MP3 result.
  const bytes = new Uint8Array(311 * 18);
  for (let offset = 0; offset < bytes.length; offset += 18) {
    bytes.set([255, 251, 0, 192], offset);
  }
  const terminal = terminalCancellation(bytes);
  try {
    await expect(countMp3Frames(terminal.input, { signal: terminal.signal })).rejects.toMatchObject(
      {
        kind: 'truncated-mp3',
        offset: bytes.length,
        message: 'Unexpected end of MP3',
      },
    );
    expect(terminal.observed).toEqual({ reads: 2, returns: 0 });
  } finally {
    await terminal.settle();
  }
  expect(terminal.signal.reason).toBe(terminal.reason);
});
