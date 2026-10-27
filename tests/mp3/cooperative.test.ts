import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { AsyncByteReader } from '../../src/mp3/byte-reader.js';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { frame } from '../helpers/mp3-fixtures.js';
import { metadataTag, metadataV1 } from '../helpers/metadata-fixtures.js';
import {
  TRAVERSAL_BYTE_QUANTUM,
  TRAVERSAL_WORK_QUANTUM,
  TraversalScheduler,
  yieldToEventLoop,
} from '../../src/mp3/cooperative.js';

it('uses exact deterministic operation intervals and resets after each real turn', async () => {
  expect(TRAVERSAL_WORK_QUANTUM).toBe(1024);
  const scheduling = new TraversalScheduler();
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let index = 1; index < TRAVERSAL_WORK_QUANTUM; index++) {
      expect(scheduling.checkpoint()).toBe(false);
    }
    expect(scheduling.checkpoint()).toBe(true);
    const turn = scheduling.waitForTurn();
    let completed = false;
    void turn.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false); // A resolved-promise microtask is not sufficient.
    await turn;
    expect(completed).toBe(true);
  }
});

it('also yields when the cumulative consumed-byte interval is reached', async () => {
  expect(TRAVERSAL_BYTE_QUANTUM).toBe(256 * 1024);
  const scheduling = new TraversalScheduler();
  expect(scheduling.checkpoint(1)).toBe(false);
  expect(scheduling.checkpoint(TRAVERSAL_BYTE_QUANTUM - 2)).toBe(false);
  expect(scheduling.checkpoint(1)).toBe(true);
  await scheduling.waitForTurn();
  expect(scheduling.checkpoint(TRAVERSAL_BYTE_QUANTUM - 1)).toBe(false);
  expect(scheduling.checkpoint(TRAVERSAL_BYTE_QUANTUM * 128)).toBe(true);
  await scheduling.waitForTurn();
  expect(scheduling.checkpoint()).toBe(false);
});

it('lets a queued event-loop turn run during one lookahead over ready one-byte chunks', async () => {
  async function* input() {
    for (let index = 0; index < 1_024; index++) yield new Uint8Array([index & 255]);
  }
  const reader = new AsyncByteReader(input());
  let turnRan = false;
  const turn = nextTurn().then(() => {
    turnRan = true;
  });
  try {
    expect(await reader.has(1_024)).toBe(true);
    expect(turnRan).toBe(true);
    expect(reader.bufferedLength).toBe(1_024);
    expect(reader.offset).toBe(0);
  } finally {
    await reader.close();
    await turn;
  }
});

it('finishes a small ready lookahead and skip without scheduling an early event-loop turn', async () => {
  async function* input() {
    yield new Uint8Array([42]);
  }
  const reader = new AsyncByteReader(input());
  let turnRan = false;
  const turn = nextTurn().then(() => {
    turnRan = true;
  });
  try {
    expect(await reader.has(1)).toBe(true);
    expect(reader.peek(1)).toEqual(new Uint8Array([42]));
    expect(turnRan).toBe(false);
    await reader.skipExactly(1);
    expect(reader.offset).toBe(1);
    expect(reader.bufferedLength).toBe(0);
    expect(turnRan).toBe(false);
  } finally {
    await reader.close();
    await turn;
  }
});

it('preserves cancellation before initial traversal without pulling input', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled before counting');
  let reads = 0;
  let returns = 0;
  const input = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        reads++;
        return { done: false as const, value: frame() };
      },
      return: async () => {
        returns++;
        throw new Error('Secondary cleanup failure');
      },
    }),
  };
  controller.abort(reason);
  await expect(countMp3Frames(input, { signal: controller.signal })).rejects.toBe(reason);
  expect(reads).toBe(0);
  expect(returns).toBe(1);
});

it('preserves cancellation at a later frame boundary and closes the unfinished iterator', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled before the next frame');
  let reads = 0;
  let returns = 0;
  const input = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (++reads === 2) controller.abort(reason);
        return { done: false as const, value: frame() };
      },
      return: async () => {
        returns++;
        return { done: true as const, value: undefined };
      },
    }),
  };
  await expect(countMp3Frames(input, { signal: controller.signal })).rejects.toBe(reason);
  expect(reads).toBe(2);
  expect(returns).toBe(1);
});

it('preserves cancellation before checking work and before/after a scheduled turn', async () => {
  const controller = new AbortController();
  const reason = new Error('Exact caller reason');
  const queued = nextTurn().then(() => controller.abort(reason));
  const scheduling = new TraversalScheduler(controller.signal);
  expect(scheduling.checkpoint(TRAVERSAL_BYTE_QUANTUM)).toBe(true);
  await expect(scheduling.waitForTurn()).rejects.toBe(reason);
  await queued;
  expect(() => scheduling.checkpoint()).toThrow(reason);
  let anotherTurnRan = false;
  const anotherTurn = nextTurn().then(() => {
    anotherTurnRan = true;
  });
  await expect(yieldToEventLoop(controller.signal)).rejects.toBe(reason);
  expect(anotherTurnRan).toBe(false);
  await anotherTurn;
});

it('cancels buffered traversal after observed EOF without returning an exhausted iterator again', async () => {
  const controller = new AbortController();
  let reads = 0;
  let returns = 0;
  const reader = new AsyncByteReader(
    {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: reads++ > 0, value: new Uint8Array(16) }),
        return: async () => {
          returns++;
          return { done: true as const, value: undefined };
        },
      }),
    },
    controller.signal,
  );
  expect(await reader.has(17)).toBe(false);
  expect(reader.bufferedLength).toBe(16);
  const reason = new Error('Peer disconnected after EOF');
  controller.abort(reason);
  await expect(reader.skipExactly(1)).rejects.toBe(reason);
  await reader.close();
  expect(reader.offset).toBe(0);
  expect(reader.bufferedLength).toBe(0);
  expect(reads).toBe(2);
  expect(returns).toBe(0);
});

it('records EOF before observing a cancellation delivered with the final upstream read', async () => {
  const controller = new AbortController();
  const reason = new Error('Abort during final read');
  let returns = 0;
  const reader = new AsyncByteReader(
    {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          controller.abort(reason);
          return { done: true as const, value: undefined };
        },
        return: async () => {
          returns++;
          return { done: true as const, value: undefined };
        },
      }),
    },
    controller.signal,
  );
  await expect(reader.has(1)).rejects.toBe(reason);
  await reader.close();
  expect(returns).toBe(0);
});

it.each(['ordinary EOF', 'ID3v1 tail', 'ID3v2.4 footer'])(
  'does not return a frame count if cancellation arrives with %s',
  async (ending) => {
    const controller = new AbortController();
    const reason = new Error('Peer closed during final read');
    const tail =
      ending === 'ID3v1 tail'
        ? metadataV1()
        : ending === 'ID3v2.4 footer'
          ? metadataTag(4, { footer: true })
          : Buffer.alloc(0);
    const bytes = Buffer.concat([frame(), tail]);
    let reads = 0;
    let returns = 0;
    const input = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (reads++ === 0) return { done: false as const, value: bytes };
          controller.abort(reason);
          return { done: true as const, value: undefined };
        },
        return: async () => {
          returns++;
          return { done: true as const, value: undefined };
        },
      }),
    };
    await expect(countMp3Frames(input, { signal: controller.signal })).rejects.toBe(reason);
    expect(reads).toBe(2);
    expect(returns).toBe(0);
  },
);
