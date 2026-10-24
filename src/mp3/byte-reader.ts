import { Mp3ParseError } from './errors.js';

/**
 * Incremental byte cursor. Retains at most one input chunk plus bounded lookahead.
 * Never creates a buffer proportional to the complete file size.
 */
export class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly queued: Uint8Array[] = [];
  private headOffset = 0;
  private available = 0;
  private ended = false;
  private absoluteOffset = 0;

  constructor(input: AsyncIterable<Uint8Array>) {
    this.iterator = input[Symbol.asyncIterator]();
  }

  get offset(): number {
    return this.absoluteOffset;
  }

  /** Stop consuming on early rejection and release any retained stream chunk. */
  async close(): Promise<void> {
    this.queued.length = 0;
    this.available = 0;
    this.headOffset = 0;
    if (!this.ended) {
      this.ended = true;
      await this.iterator.return?.();
    }
  }

  async has(length: number): Promise<boolean> {
    if (!Number.isSafeInteger(length) || length < 0 || length > 1_500) {
      throw new RangeError('Lookahead must be between 0 and 1500 bytes');
    }
    while (this.available < length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
      } else if (next.value.length > 0) {
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
    const first = this.queued[0];
    if (first !== undefined && first.length - this.headOffset >= length) {
      return first.subarray(this.headOffset, this.headOffset + length);
    }
    const bytes = new Uint8Array(length);
    let written = 0;
    for (let i = 0; i < this.queued.length && written < length; i++) {
      const chunk = this.queued[i]!;
      const start = i === 0 ? this.headOffset : 0;
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
      const head = this.queued[0]!;
      const take = Math.min(remaining, head.length - this.headOffset);
      this.headOffset += take;
      this.absoluteOffset += take;
      this.available -= take;
      remaining -= take;
      if (this.headOffset === head.length) {
        this.queued.shift();
        this.headOffset = 0;
      }
    }
  }
}
