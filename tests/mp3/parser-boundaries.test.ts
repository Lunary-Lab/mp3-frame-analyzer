import { expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AsyncByteReader } from '../../src/mp3/byte-reader.js';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { Mp3ParseError } from '../../src/mp3/errors.js';
import { chunks, frame, id3v1, id3v2, mp3 } from '../helpers/mp3-fixtures.js';

it.each([1, 64])(
  'keeps queue storage bounded with repeated %i-byte lookahead',
  async (lookahead) => {
    const collect = global.gc;
    if (!collect) throw new Error('Queue lifetime verification requires --expose-gc');
    const byte = Uint8Array.of(1);
    async function* source(): AsyncGenerator<Uint8Array> {
      for (;;) yield byte;
    }
    const reader = new AsyncByteReader(source());
    const advance = async (count: number) => {
      for (let index = 0; index < count; index++) {
        await reader.has(lookahead);
        await reader.skipExactly(1);
      }
    };
    try {
      await advance(16_000); // Warm the cursor paths before measuring live storage.
      await nextTurn();
      collect();
      const before = process.memoryUsage().heapUsed;
      await advance(400_000);
      await nextTurn();
      collect();
      const growth = process.memoryUsage().heapUsed - before;
      expect(reader.offset).toBe(416_000);
      expect(reader.bufferedLength).toBe(lookahead - 1);
      // Reusing one input byte isolates queue bookkeeping from payload allocation.
      // Without compaction, 400k consumed array slots retain several MiB.
      expect(growth).toBeLessThan(2 * 1024 * 1024);
    } finally {
      await reader.close();
    }
  },
);

it('does not read upstream for zero-byte lookahead, peek or skip', async () => {
  let calls = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          calls++;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const reader = new AsyncByteReader(source);
  expect(await reader.has(0)).toBe(true);
  expect(reader.peek(0)).toEqual(new Uint8Array());
  await reader.skipExactly(0);
  expect(calls).toBe(0);
  expect(await reader.has(1)).toBe(false);
  expect(await reader.has(1)).toBe(false);
  expect(calls).toBe(1);
  await reader.close();
});

it('preserves buffered bytes after EOF and releases them on close', async () => {
  let calls = 0;
  let returns = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          calls++;
          return calls === 1
            ? { done: false as const, value: Uint8Array.of(10, 20, 30) }
            : { done: true as const, value: undefined };
        },
        async return() {
          returns++;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const reader = new AsyncByteReader(source);
  expect(await reader.has(4)).toBe(false);
  expect(calls).toBe(2);
  expect(await reader.has(3)).toBe(true);
  expect([...reader.peek(3)]).toEqual([10, 20, 30]);
  await reader.skipExactly(1);
  expect(reader.offset).toBe(1);
  expect([...reader.peek(2)]).toEqual([20, 30]);
  expect(await reader.has(3)).toBe(false);
  expect(calls).toBe(2);
  await reader.close();
  expect(returns).toBe(0);
  expect(reader.offset).toBe(1);
  expect(reader.peek(0)).toEqual(new Uint8Array());
  expect(() => reader.peek(1)).toThrow('Insufficient buffered data');
  expect(await reader.has(1)).toBe(false);
});

it('keeps lookahead within the inclusive 12,288-byte boundary', async () => {
  const bytes = Uint8Array.from({ length: 12_288 }, (_, i) => i % 256);
  const reader = new AsyncByteReader(chunks(bytes, [499, 501, 500]));
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 12_289]) {
    await expect(reader.has(size)).rejects.toThrow('Lookahead must be between 0 and 12288 bytes');
  }
  expect(await reader.has(12_288)).toBe(true);
  expect(reader.peek(12_288)).toEqual(bytes);
  expect(reader.offset).toBe(0);
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 12_289]) {
    expect(() => reader.peek(size)).toThrow('Insufficient buffered data');
  }
  for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(reader.skipExactly(size)).rejects.toThrow('Invalid skip length');
  }
  await reader.skipExactly(12_288);
  expect(reader.offset).toBe(12_288);
  expect(await reader.has(1)).toBe(false);
});

it('copies cross-chunk lookahead with a partial head and leaves input untouched', async () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
  const reader = new AsyncByteReader(chunks(bytes, [4, 3, 11, 14]));
  expect(await reader.has(20)).toBe(true);
  await reader.skipExactly(2);
  expect([...reader.peek(17)]).toEqual(Array.from({ length: 17 }, (_, i) => i + 2));
  expect(reader.offset).toBe(2);
  await reader.skipExactly(13);
  expect(reader.offset).toBe(15);
  expect([...reader.peek(3)]).toEqual([15, 16, 17]);
  await reader.skipExactly(17);
  expect(reader.offset).toBe(32);
  expect(await reader.has(1)).toBe(false);
  expect([...bytes]).toEqual(Array.from({ length: 32 }, (_, i) => i));
});

it('allows exactly 1024 consecutive empty chunks and resets the count after progress', async () => {
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < 1024; n++) yield new Uint8Array();
      yield Uint8Array.of(pass + 10);
    }
  }
  const reader = new AsyncByteReader(source());
  expect(await reader.has(2)).toBe(true);
  expect([...reader.peek(2)]).toEqual([10, 11]);
  await reader.close();
});

it('rejects the 1025th consecutive empty chunk at the exact consumed offset', async () => {
  let emitted = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    yield Uint8Array.of(1, 2, 3);
    for (let n = 0; n < 1100; n++) {
      emitted++;
      yield new Uint8Array();
    }
  }
  const reader = new AsyncByteReader(source());
  await reader.skipExactly(3);
  await expect(reader.has(1)).rejects.toMatchObject({
    name: 'Mp3ParseError',
    kind: 'invalid-mp3',
    offset: 3,
    message: 'Input stream made no progress',
  });
  expect(emitted).toBe(1025);
  await reader.close();
});

it('does not retry upstream teardown when return rejects', async () => {
  let attempts = 0;
  const cause = new Error('teardown failed');
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false as const, value: Uint8Array.of(1) };
        },
        async return() {
          attempts++;
          throw cause;
        },
      };
    },
  };
  const reader = new AsyncByteReader(source);
  expect(await reader.has(1)).toBe(true);
  await expect(reader.close()).rejects.toBe(cause);
  await reader.close();
  expect(attempts).toBe(1);
  expect(await reader.has(1)).toBe(false);
});

it('preserves upstream next failures and invokes upstream return', async () => {
  let returned = false;
  const cause = new Error('upstream disconnected');
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw cause;
        },
        async return() {
          returned = true;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  await expect(countMp3Frames(source)).rejects.toBe(cause);
  expect(returned).toBe(true);
});

it('reports the typed error name, code, byte offset and supplied message', () => {
  for (const kind of ['invalid-mp3', 'unsupported-format', 'truncated-mp3'] as const) {
    const error = new Mp3ParseError(kind, 123, 'specific cause');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'Mp3ParseError',
      kind,
      offset: 123,
      message: 'specific cause',
    });
    expect(String(error)).toBe('Mp3ParseError: specific cause');
  }
});

it('continues validating each leading tag after the former eight-tag boundary', async () => {
  const tag = id3v2(Buffer.alloc(0));
  const nine = Buffer.concat([...Array<Buffer>(9).fill(tag), frame()]);
  await expect(countMp3Frames(chunks(nine, [3, 7]))).resolves.toBe(1);
  const truncated = Buffer.concat([...Array<Buffer>(9).fill(tag), tag.subarray(0, 7)]);
  await expect(countMp3Frames(chunks(truncated, [3, 7]))).rejects.toMatchObject({
    kind: 'truncated-mp3',
    offset: 90,
    message: 'Incomplete ID3v2 tag header',
  });
});

it('rejects truncated ID3 headers and footers with the exact failure location', async () => {
  await expect(countMp3Frames(chunks(Buffer.from('ID3'), [1]))).rejects.toMatchObject({
    kind: 'truncated-mp3',
    offset: 0,
    message: 'Incomplete ID3v2 tag header',
  });
  const tag = id3v2(Buffer.alloc(9), 4, true);
  await expect(countMp3Frames(chunks(tag.subarray(0, -1), [2]))).rejects.toMatchObject({
    kind: 'truncated-mp3',
    offset: 19,
    message: 'Incomplete ID3v2 footer',
  });
  for (let index = 0; index < 10; index++) {
    const bad = Buffer.from(tag);
    bad[19 + index] = bad[19 + index]! ^ 1;
    await expect(
      countMp3Frames(chunks(Buffer.concat([bad, frame()]), [1, 4])),
    ).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: 19,
      message: 'Invalid ID3v2 footer',
    });
  }
});

it('uses exact error codes, messages and offsets at frame and trailer boundaries', async () => {
  const audio = frame();
  await expect(countMp3Frames(chunks(new Uint8Array(), [1]))).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: 0,
    message: 'No MPEG-1 Layer III frames found',
  });
  await expect(countMp3Frames(chunks(Buffer.from('not audio'), [1]))).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: 0,
    message: 'Invalid MPEG-1 Layer III frame header',
  });
  await expect(
    countMp3Frames(chunks(Buffer.concat([audio, Buffer.from([0xff])]), [7])),
  ).rejects.toMatchObject({
    kind: 'truncated-mp3',
    offset: audio.length,
    message: 'Incomplete trailing frame header',
  });
  const unsupported = frame();
  unsupported[1] = 0xf3;
  await expect(countMp3Frames(chunks(mp3([audio, unsupported]), [4]))).rejects.toMatchObject({
    kind: 'unsupported-format',
    offset: audio.length,
    message: 'Only MPEG-1 Layer III is supported',
  });
  await expect(
    countMp3Frames(chunks(Buffer.concat([audio, id3v1(), Buffer.of(1)]), [5])),
  ).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: audio.length + 128,
    message: 'Unexpected bytes after trailing metadata',
  });
  await expect(countMp3Frames(chunks(id3v1(), [1]))).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: 0,
    message: 'Invalid MPEG-1 Layer III frame header',
  });
});

it('close releases a retained input buffer, not just its logical available count', async () => {
  const collect = global.gc;
  if (!collect)
    throw new Error('This lifetime test requires the configured --expose-gc test worker');
  let reference: WeakRef<Uint8Array> | undefined;
  let sent = false;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (sent) return { done: true as const, value: undefined };
          sent = true;
          const value = new Uint8Array(32 * 1024);
          reference = new WeakRef(value);
          return { done: false as const, value };
        },
        async return() {
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const reader = new AsyncByteReader(source);
  expect(await reader.has(1)).toBe(true);
  await reader.skipExactly(1);
  await reader.close();
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    collect();
    if (reference?.deref() === undefined) break;
  }
  expect(reference).toBeDefined();
  expect(reference!.deref()).toBeUndefined();
  // Keep the reader alive: collecting the reader itself would hide a leak.
  expect(reader.offset).toBe(1);
});

it('does not mistake near-ID3 prefixes for tag headers', async () => {
  for (const marker of ['XD3', 'IX3', 'IDX', 'XX3', 'ID4']) {
    const bytes = Buffer.concat([Buffer.from(marker), Buffer.alloc(7), frame()]);
    await expect(countMp3Frames(chunks(bytes, [1]))).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: 0,
      message: 'Invalid MPEG-1 Layer III frame header',
    });
  }
});

it('maintains absolute error offsets through preceding metadata', async () => {
  const tag = id3v2(Buffer.alloc(12));
  const invalid = id3v2(Buffer.alloc(0));
  invalid[6] = 0x80;
  await expect(
    countMp3Frames(chunks(Buffer.concat([tag, invalid, frame()]), [3])),
  ).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: tag.length + 6,
    message: 'Invalid synchsafe ID3v2 size',
  });
  await expect(
    countMp3Frames(chunks(Buffer.concat([tag, Buffer.from('ID3')]), [3])),
  ).rejects.toMatchObject({
    kind: 'truncated-mp3',
    offset: tag.length,
    message: 'Incomplete ID3v2 tag header',
  });
});

it('closes a source without the optional iterator return method', async () => {
  const reader = new AsyncByteReader({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false as const, value: Uint8Array.of(1, 2) };
        },
      };
    },
  });
  expect(await reader.has(1)).toBe(true);
  await reader.close();
  await reader.close();
  expect(await reader.has(1)).toBe(false);
});

it('preserves the zero-copy fast path when lookahead exactly fits the head chunk', async () => {
  const bytes = Uint8Array.of(10, 20, 30, 40);
  const reader = new AsyncByteReader(chunks(bytes, [4]));
  expect(await reader.has(4)).toBe(true);
  const whole = reader.peek(4);
  expect(whole.buffer).toBe(bytes.buffer);
  expect(whole.byteOffset).toBe(bytes.byteOffset);
  await reader.skipExactly(1);
  const rest = reader.peek(3);
  expect(rest.buffer).toBe(bytes.buffer);
  expect(rest.byteOffset).toBe(bytes.byteOffset + 1);
  expect([...rest]).toEqual([20, 30, 40]);
  await reader.close();
});

it('reports byte truncation with an absolute offset and stable message', async () => {
  const reader = new AsyncByteReader(chunks(Uint8Array.of(1, 2, 3, 4), [3, 1]));
  await reader.skipExactly(3);
  await expect(reader.skipExactly(2)).rejects.toMatchObject({
    name: 'Mp3ParseError',
    kind: 'truncated-mp3',
    offset: 4,
    message: 'Unexpected end of MP3',
  });
  expect(reader.offset).toBe(4);
  await reader.close();
});
