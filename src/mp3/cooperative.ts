import { setImmediate as nextTurn } from 'node:timers/promises';

/** Scheduling intervals, not upload limits or MPEG-format restrictions. */
export const TRAVERSAL_WORK_QUANTUM = 1_024;
export const TRAVERSAL_BYTE_QUANTUM = 256 * 1_024;

/** Let I/O/timers progress and preserve the caller's exact cancellation reason. */
export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await nextTurn();
  signal?.throwIfAborted();
}

/** Constant-space counters shared by one reader's lookahead, pulls and skips. */
export class TraversalScheduler {
  private operations = 0;
  private bytes = 0;
  private readonly signal: AbortSignal | undefined;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  /** Check cancellation and account work synchronously; tell the caller when to wait. */
  checkpoint(consumedBytes = 0): boolean {
    this.signal?.throwIfAborted();
    this.operations++;
    this.bytes += consumedBytes;
    if (this.operations < TRAVERSAL_WORK_QUANTUM && this.bytes < TRAVERSAL_BYTE_QUANTUM) {
      return false;
    }
    this.operations = 0;
    this.bytes = 0;
    return true;
  }

  /** Wait immediately after a checkpoint reports that a real turn is due. */
  waitForTurn(): Promise<void> {
    return yieldToEventLoop(this.signal);
  }
}
