import { describe, expect, it } from 'vitest';
import { AsyncByteReader } from '../../src/mp3/byte-reader.js';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { decodeFrameHeader } from '../../src/mp3/frame-header.js';
import { inferFreeFormatBaseLength } from '../../src/mp3/free-format.js';
import { frame, id3v1, id3v2 } from '../helpers/mp3-fixtures.js';

/** Record upstream ownership without intercepting or modifying parser internals. */
function trackedInput(parts: readonly Uint8Array[], readFailure?: Error, closeFailure?: Error) {
  const events: string[] = [];
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          events.push(`next:${index}`);
          const value = parts[index++];
          if (value !== undefined) return { done: false as const, value };
          if (readFailure) throw readFailure;
          return { done: true as const, value: undefined };
        },
        async return() {
          events.push('return');
          if (closeFailure) throw closeFailure;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  return { input, events };
}

function infoFrame(): Buffer {
  const bytes = frame();
  bytes.write('Info', 36, 'ascii');
  bytes.writeUInt32BE(0x00000003, 40);
  return bytes;
}

describe('frame traversal characterization', () => {
  it.each([undefined, true, false])(
    'preserves EOF classification, offsets and upstream pulls with inclusion %s',
    async (includeVbrHeaderFrame) => {
      const options = includeVbrHeaderFrame === undefined ? {} : { includeVbrHeaderFrame };
      const audio = frame();
      const tag = id3v2(Buffer.alloc(7));
      const cases = [
        { bytes: Buffer.alloc(0), offset: 0, kind: 'invalid-mp3' },
        { bytes: Buffer.from([0xff, 0xfb, 0x90]), offset: 0, kind: 'invalid-mp3' },
        { bytes: tag, offset: tag.length, kind: 'invalid-mp3' },
        ...[1, 2, 3].map((length) => ({
          bytes: Buffer.concat([audio, Buffer.alloc(length, 0xff)]),
          offset: audio.length,
          kind: 'truncated-mp3',
        })),
      ];
      for (const { bytes, offset, kind } of cases) {
        const { input, events } = trackedInput([bytes]);
        await expect(countMp3Frames(input, options)).rejects.toMatchObject({
          name: 'Mp3ParseError',
          kind,
          offset,
          message:
            kind === 'invalid-mp3'
              ? 'No MPEG-1 Layer III frames found'
              : 'Incomplete trailing frame header',
        });
        expect(events).toEqual(['next:0', 'next:1']);
      }
    },
  );

  it.each([undefined, true, false])(
    'retains physical-first-frame accounting and EOF ownership with inclusion %s',
    async (includeVbrHeaderFrame) => {
      const options = includeVbrHeaderFrame === undefined ? {} : { includeVbrHeaderFrame };
      const initial = infoFrame();
      const cases = [
        { bytes: initial, count: includeVbrHeaderFrame === false ? 0 : 1 },
        {
          bytes: Buffer.concat([initial, frame(), id3v1()]),
          count: includeVbrHeaderFrame === false ? 1 : 2,
        },
        { bytes: Buffer.concat([frame(), initial]), count: 2 },
      ];
      for (const { bytes, count } of cases) {
        const { input, events } = trackedInput([bytes]);
        await expect(countMp3Frames(input, options)).resolves.toBe(count);
        expect(events).toEqual(['next:0', 'next:1']);
      }
    },
  );

  it.each([true, false])(
    'does not read after an invalid boundary with inclusion %s',
    async (include) => {
      const audio = frame();
      const { input, events } = trackedInput(
        [Buffer.concat([audio, Buffer.from('nope')]), frame()],
        undefined,
        new Error('cleanup failed'),
      );
      await expect(countMp3Frames(input, { includeVbrHeaderFrame: include })).rejects.toMatchObject(
        {
          name: 'Mp3ParseError',
          kind: 'invalid-mp3',
          offset: audio.length,
          message: 'Invalid MPEG-1 Layer III frame header',
        },
      );
      expect(events).toEqual(['next:0', 'return']);
    },
  );

  it.each([true, false])('retains upstream failure identity with inclusion %s', async (include) => {
    const failure = new Error('read failed');
    const { input, events } = trackedInput([infoFrame()], failure, new Error('cleanup failed'));
    await expect(countMp3Frames(input, { includeVbrHeaderFrame: include })).rejects.toBe(failure);
    expect(events).toEqual(['next:0', 'next:1', 'return']);
  });
});

function headerWindow(length: number, offsets: readonly number[]): Buffer {
  const bytes = Buffer.alloc(length, 0x11);
  for (const offset of offsets) bytes.set([0xff, 0xfb, 0, 0xc4], offset);
  return bytes;
}

async function infer(reader: AsyncByteReader): Promise<number> {
  await reader.has(4);
  const header = decodeFrameHeader(reader.peek(4));
  if (header.kind !== 'free-format') throw new Error('Expected a free-format fixture');
  return inferFreeFormatBaseLength(reader, header);
}

describe('free-format candidate characterization', () => {
  it.each([
    {
      label: 'a later longer chain resets a prior tie',
      offsets: [0, 100, 140, 180, 200, 280, 360, 540],
      base: 180,
    },
    {
      label: 'a later shorter chain cannot replace the best',
      offsets: [0, 100, 140, 200, 280, 300, 400],
      base: 100,
    },
  ])('$label', async ({ offsets, base }) => {
    const bytes = headerWindow(600, offsets);
    const { input, events } = trackedInput([bytes]);
    const reader = new AsyncByteReader(input);
    await expect(infer(reader)).resolves.toBe(base);
    expect(reader.offset).toBe(0);
    expect(reader.bufferedLength).toBe(bytes.length);
    expect(reader.peek(bytes.length)).toEqual(bytes);
    expect(events).toEqual(['next:0', 'next:1']);
    await reader.close();
    expect(events).toEqual(['next:0', 'next:1']);
  });

  it('retains the original start offset and bytes when equally strong chains reject', async () => {
    const prefix = Buffer.alloc(9);
    const bytes = headerWindow(600, [0, 100, 200, 140, 280]);
    const { input, events } = trackedInput([Buffer.concat([prefix, bytes])]);
    const reader = new AsyncByteReader(input);
    await reader.skipExactly(prefix.length);
    await expect(infer(reader)).rejects.toMatchObject({
      name: 'Mp3ParseError',
      kind: 'unsupported-format',
      offset: prefix.length,
      message: 'Ambiguous free-format MPEG frame layout',
    });
    expect(reader.offset).toBe(prefix.length);
    expect(reader.peek(bytes.length)).toEqual(bytes);
    expect(events).toEqual(['next:0', 'next:1']);
    await reader.close();
  });

  it.each([8648, 9000])(
    'stops discovery after the bounded probe and EOF witness within a %i-byte input chunk',
    async (size) => {
      const bytes = headerWindow(size, [0, 1001, 2002, 3003]);
      for (const offset of [0, 1001, 2002, 3003]) bytes[offset + 2] = 2;
      const { input, events } = trackedInput([bytes], new Error('must not request another chunk'));
      const reader = new AsyncByteReader(input);
      await expect(infer(reader)).resolves.toBe(1000);
      expect(reader.offset).toBe(0);
      expect(reader.bufferedLength).toBe(size);
      expect(reader.peek(size)).toEqual(bytes);
      expect(events).toEqual(['next:0']);
      await reader.close();
      expect(events).toEqual(['next:0', 'return']);
    },
  );

  it('requests EOF once when the input exactly fills the searched window', async () => {
    const bytes = headerWindow(8647, [0, 1001, 2002, 3003]);
    for (const offset of [0, 1001, 2002, 3003]) bytes[offset + 2] = 2;
    const { input, events } = trackedInput([bytes]);
    const reader = new AsyncByteReader(input);
    await expect(infer(reader)).resolves.toBe(1000);
    expect(reader.offset).toBe(0);
    expect(reader.bufferedLength).toBe(8647);
    expect(reader.peek(8647)).toEqual(bytes);
    expect(events).toEqual(['next:0', 'next:1']);
    await reader.close();
    expect(events).toEqual(['next:0', 'next:1']);

    const failure = new Error('EOF witness read failed');
    const failed = trackedInput([bytes], failure);
    await expect(countMp3Frames(failed.input)).rejects.toBe(failure);
    expect(failed.events).toEqual(['next:0', 'next:1', 'return']);
  });
});
