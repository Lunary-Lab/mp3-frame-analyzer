import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, frame } from './helpers/mp3-fixtures.js';
import { terminalCancellation } from './helpers/terminal-cancellation.js';

function indexed(bytes: number): Uint8Array {
  const result = new Uint8Array(Math.floor(bytes / 417) * 417);
  for (let offset = 0; offset < result.length; offset += 417) {
    result.set([255, 251, 144, 0], offset);
  }
  return result;
}
function metadata(bodyBytes: number): Uint8Array {
  const result = new Uint8Array(bodyBytes + 10 + 417);
  result.set([
    73,
    68,
    51,
    4,
    0,
    0,
    (bodyBytes >>> 21) & 127,
    (bodyBytes >>> 14) & 127,
    (bodyBytes >>> 7) & 127,
    bodyBytes & 127,
  ]);
  result.set(frame(), bodyBytes + 10);
  return result;
}
async function expectTurnBeforeCompletion(bytes: Uint8Array, sizes: number[], count: number) {
  let ran = false;
  const turn = nextTurn().then(() => {
    ran = true;
  });
  try {
    expect(await countMp3Frames(chunks(bytes, sizes))).toBe(count);
    expect(ran).toBe(true);
  } finally {
    await turn;
  }
}

it('yields while traversing an already-buffered 128 MiB indexed upload', async () => {
  const bytes = indexed(128 * 1024 * 1024);
  await expectTurnBeforeCompletion(bytes, [bytes.length], bytes.length / 417);
});

it.each(['buffered', 'streamed'])('yields during a 32 MiB %s ID3 body', async (mode) => {
  const bytes = metadata(32 * 1024 * 1024);
  await expectTurnBeforeCompletion(bytes, [mode === 'buffered' ? bytes.length : 64 * 1024], 1);
});

it('yields while traversing many tiny tags even below the byte quantum', async () => {
  const bytes = new Uint8Array(16_384 * 10 + 417);
  for (let offset = 0; offset < bytes.length - 417; offset += 10) {
    bytes.set([73, 68, 51, 4], offset);
  }
  bytes.set(frame(), bytes.length - 417);
  await expectTurnBeforeCompletion(bytes, [bytes.length], 1);
});

it('yields on one-byte upstream chunks without changing frame count', async () => {
  const bytes = indexed(64 * 1024);
  await expectTurnBeforeCompletion(bytes, [1], bytes.length / 417);
});

it.each(['indexed', 'metadata'])(
  'observes cancellation before exhausting buffered %s work',
  async (kind) => {
    const bytes = kind === 'indexed' ? indexed(4 * 1024 * 1024) : metadata(4 * 1024 * 1024);
    const controller = new AbortController();
    const reason = new Error('Peer stopped buffered traversal');
    let closed = 0;
    let nextChunk = false;
    async function* input() {
      try {
        yield bytes;
        nextChunk = true;
        yield frame();
      } finally {
        closed++;
      }
    }
    const turn = nextTurn().then(() => controller.abort(reason));
    await expect(countMp3Frames(input(), { signal: controller.signal })).rejects.toBe(reason);
    await turn;
    expect(closed).toBe(1);
    expect(nextChunk).toBe(false);
  },
);

// 679 frames place terminal ID3v1 traversal just below the real-turn quantum.
// Extra cached-EOF lookaheads would yield and change a completed count into
// caller cancellation. Neighboring lengths guard against an always-abort oracle.
it.each([678, 679, 680])(
  'finishes %i indexed frames and final ID3v1 before a queued terminal-EOF cancellation',
  async (frames) => {
    const bytes = new Uint8Array(frames * 96 + 128);
    for (let offset = 0; offset < frames * 96; offset += 96) {
      bytes.set([255, 251, 20, 0], offset);
    }
    bytes.set([84, 65, 71], frames * 96);
    const terminal = terminalCancellation(bytes);
    try {
      await expect(countMp3Frames(terminal.input, { signal: terminal.signal })).resolves.toBe(
        frames,
      );
      expect(terminal.observed).toEqual({ reads: 2, returns: 0 });
    } finally {
      await terminal.settle();
    }
    expect(terminal.signal.reason).toBe(terminal.reason);
  },
);
