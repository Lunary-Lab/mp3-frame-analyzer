import { setImmediate as nextTurn } from 'node:timers/promises';

/** Ordinary iterator that queues caller cancellation only when it reports EOF. */
export function terminalCancellation(bytes: Uint8Array) {
  const controller = new AbortController();
  const reason = new Error('Caller cancellation queued at terminal EOF');
  const observed = { reads: 0, returns: 0 };
  let cancellation: Promise<void> | undefined;
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          observed.reads++;
          if (observed.reads === 1) return { done: false, value: bytes };
          cancellation = nextTurn().then(() => controller.abort(reason));
          return { done: true, value: undefined };
        },
        async return() {
          observed.returns++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return {
    input,
    signal: controller.signal,
    reason,
    observed,
    async settle() {
      await cancellation;
    },
  };
}
