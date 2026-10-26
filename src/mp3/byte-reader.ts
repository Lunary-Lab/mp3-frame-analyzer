import { Mp3ParseError } from './errors.js';

/**
 * Incremental byte cursor. Parser callers request bounded lookahead; queued
 * view lengths are bounded by that lookahead plus the largest input chunk.
 * Views can retain larger upstream backing buffers.
 */
export class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly queued: (Uint8Array | undefined)[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private available = 0;
  private ended = false;
  private absoluteOffset = 0;
  private static readonly MAX_EMPTY_CHUNKS = 1_024;

  constructor(input: AsyncIterable<Uint8Array>) {
    this.iterator = input[Symbol.asyncIterator]();
  }

  get offset(): number {
    return this.absoluteOffset;
  }

  /** Bytes currently buffered, including any free-format lookahead. */
  get bufferedLength(): number {
    return this.available;
  }

  /** Stop consuming on early rejection and release any retained stream chunk. */
  async close(): Promise<void> {
    this.queued.length = 0;
    this.headIndex = 0;
    this.available = 0;
    this.headOffset = 0;
    if (!this.ended) {
      this.ended = true;
      await this.iterator.return?.();
    }
  }

  async has(length: number): Promise<boolean> {
    if (!Number.isSafeInteger(length) || length < 0 || length > 12_288) {
      throw new RangeError('Lookahead must be between 0 and 12288 bytes');
    }
    let consecutiveEmptyChunks = 0;
    while (this.available < length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
      } else if (!(next.value instanceof Uint8Array)) {
        throw new Mp3ParseError('invalid-mp3', this.absoluteOffset, 'Invalid byte stream chunk');
      } else if (next.value.length === 0) {
        // An async iterable can yield empty buffers indefinitely without ever
        // advancing the parser. Bound this case to avoid starving the event loop.
        if (++consecutiveEmptyChunks > AsyncByteReader.MAX_EMPTY_CHUNKS) {
          throw new Mp3ParseError(
            'invalid-mp3',
            this.absoluteOffset,
            'Input stream made no progress',
          );
        }
      } else {
        consecutiveEmptyChunks = 0;
        this.queued.push(next.value);
        this.available += next.value.length;
      }
    }
    return this.available >= length;
  }

  /** Call has(length) before peek; the returned view/copy must not be mutated. */
  peek(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.available) {
      throw new RangeError('Insufficient buffered data');
    }
    const first = this.queued[this.headIndex];
    if (first !== undefined && first.length - this.headOffset >= length) {
      return first.subarray(this.headOffset, this.headOffset + length);
    }
    const bytes = new Uint8Array(length);
    let written = 0;
    for (let i = this.headIndex; i < this.queued.length && written < length; i++) {
      const chunk = this.queued[i]!;
      const start = i === this.headIndex ? this.headOffset : 0;
      const take = Math.min(chunk.length - start, length - written);
      bytes.set(chunk.subarray(start, start + take), written);
      written += take;
    }
    return bytes;
  }

  /** Skips any number of bytes without allocating a buffer for them. */
  async skipExactly(length: number): Promise<void> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError('Invalid skip length');
    }
    let remaining = length;
    while (remaining > 0) {
      if (!(await this.has(1))) {
        throw new Mp3ParseError('truncated-mp3', this.absoluteOffset, 'Unexpected end of MP3');
      }
      const head = this.queued[this.headIndex]!;
      const take = Math.min(remaining, head.length - this.headOffset);
      this.headOffset += take;
      this.absoluteOffset += take;
      this.available -= take;
      remaining -= take;
      if (this.headOffset === head.length) {
        // Release consumed chunks immediately. Compact occasionally so repeated
        // lookahead/refill keeps queue storage bounded without shifting on every
        // one-byte chunk during free-format discovery.
        this.queued[this.headIndex++] = undefined;
        if (this.headIndex === this.queued.length) {
          this.queued.length = 0;
          this.headIndex = 0;
        } else if (this.headIndex >= 1_024) {
          this.queued.splice(0, this.headIndex);
          this.headIndex = 0;
        }
        this.headOffset = 0;
      }
    }
  }
}
