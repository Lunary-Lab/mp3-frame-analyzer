import { describe, expect, it } from 'vitest';
import { AsyncByteReader } from '../src/mp3/byte-reader.js';

async function* asChunks(...values: number[][]): AsyncGenerator<Uint8Array> {
  for (const bytes of values) yield Uint8Array.from(bytes);
}

describe('incremental byte reader', () => {
  it('peeks across chunk boundaries without consuming bytes', async () => {
    const reader = new AsyncByteReader(asChunks([0xff], [], [0xfb, 0x90], [0x00]));
    expect(await reader.has(4)).toBe(true);
    expect([...reader.peek(4)]).toEqual([0xff, 0xfb, 0x90, 0x00]);
    expect(reader.offset).toBe(0);

    await reader.skipExactly(3);
    expect(reader.offset).toBe(3);
    expect([...reader.peek(1)]).toEqual([0x00]);
    expect(await reader.has(2)).toBe(false);
    await reader.skipExactly(1);
    expect(reader.offset).toBe(4);
    await reader.close();
  });

  it('rejects invalid lookahead and reports the exact truncated offset', async () => {
    const reader = new AsyncByteReader(asChunks([1, 2, 3]));
    await expect(reader.has(12289)).rejects.toThrow(RangeError);
    await expect(reader.has(-1)).rejects.toThrow(RangeError);
    await expect(reader.skipExactly(4)).rejects.toMatchObject({
      kind: 'truncated-mp3',
      offset: 3,
    });
    await reader.close();
  });

  it('closes an unfinished iterator exactly once', async () => {
    let returnCount = 0;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: Uint8Array.of(42) };
          },
          async return() {
            returnCount++;
            return { done: true as const, value: undefined };
          },
        };
      },
    };

    const reader = new AsyncByteReader(input);
    expect(await reader.has(1)).toBe(true);
    await reader.close();
    await reader.close();
    expect(returnCount).toBe(1);
    expect(await reader.has(1)).toBe(false);
  });

  it('releases buffered bytes without requesting more input on close', async () => {
    let reads = 0;
    let releases = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            reads++;
            return { done: false as const, value: Uint8Array.of(1, 2, 3, 4) };
          },
          async return() {
            releases++;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const reader = new AsyncByteReader(source);
    expect(await reader.has(3)).toBe(true);
    await reader.skipExactly(1);
    await reader.close();
    expect(() => reader.peek(1)).toThrow(RangeError);
    expect(await reader.has(1)).toBe(false);
    await reader.close();
    expect(reads).toBe(1);
    expect(releases).toBe(1);
  });

  it('does not invoke return on an iterator that has naturally completed', async () => {
    let releases = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true as const, value: undefined };
          },
          async return() {
            releases++;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const reader = new AsyncByteReader(source);
    expect(await reader.has(1)).toBe(false);
    await reader.close();
    expect(releases).toBe(0);
  });
  it('rejects malformed byte chunks and invalid cursor arguments', async () => {
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: 'invalid' as unknown as Uint8Array };
          },
          async return() {
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const invalid = new AsyncByteReader(source);
    await expect(invalid.has(1)).rejects.toMatchObject({
      kind: 'invalid-mp3',
      message: 'Invalid byte stream chunk',
    });
    await invalid.close();

    const reader = new AsyncByteReader(asChunks([1, 2]));
    expect(() => reader.peek(-1)).toThrow(RangeError);
    expect(() => reader.peek(3)).toThrow(RangeError);
    await expect(reader.skipExactly(-1)).rejects.toThrow(RangeError);
    await expect(reader.skipExactly(Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
    expect(await reader.has(2)).toBe(true);
    await reader.skipExactly(0);
    expect([...reader.peek(0)]).toEqual([]);
    await reader.close();
  });
});
