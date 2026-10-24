import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { Mp3ParseError } from '../src/mp3/errors.js';
import { chunks, frame, id3v1, id3v2, mp3 } from './helpers/mp3-fixtures.js';

const count = (bytes: Uint8Array, size = bytes.length) =>
  countMp3Frames(chunks(bytes, [Math.max(1, size)]));

describe('streaming MP3 frame counting', () => {
  it('counts a single frame and multiple mixed-bitrate frames', async () => {
    expect(await count(frame())).toBe(1);
    const bytes = mp3([
      frame({ bitrateIndex: 1 }),
      frame({ bitrateIndex: 14, padding: 1 }),
      frame({ bitrateIndex: 9, sampleRateIndex: 1 }),
    ]);
    expect(await count(bytes)).toBe(3);
  });

  it('skips ID3v2, recognizes trailing ID3v1, and counts every physical MPEG frame', async () => {
    const bytes = mp3([frame(), frame()], id3v2(Buffer.alloc(202), 4, true), id3v1());
    expect(await count(bytes, 1)).toBe(2);
  });

  it.each([false, true])('excludes an appended ID3v2.4 tag (with ID3v1: %s)', async (withV1) => {
    // A complete TIT2 frame with a UTF-8 one-character title, without padding.
    const title = Buffer.from([0x54, 0x49, 0x54, 0x32, 0, 0, 0, 2, 0, 0, 3, 0x41]);
    const tail = Buffer.concat([id3v2(title, 4, true), ...(withV1 ? [id3v1()] : [])]);
    const bytes = mp3([frame(), frame({ padding: 1 })], id3v2(title, 3), tail);
    for (const size of [1, 4, 17, 4096]) {
      expect(await count(bytes, size)).toBe(2);
    }
  });

  it.each([2, 3, 4] as const)(
    'requires a footer on appended ID3v2.%i metadata',
    async (version) => {
      const audio = frame();
      await expect(
        count(mp3([audio], undefined, id3v2(Buffer.alloc(12), version))),
      ).rejects.toMatchObject({
        kind: 'invalid-mp3',
        offset: audio.length,
        message: 'Appended ID3v2 tags must use version 2.4 with a footer',
      });
    },
  );

  it('requires appended metadata to follow all audio and precede final ID3v1', async () => {
    const tag = id3v2(Buffer.alloc(12), 4, true);
    for (const tail of [
      Buffer.concat([tag, frame()]),
      Buffer.concat([tag, tag]),
      Buffer.concat([tag, Buffer.from([1, 2])]),
      Buffer.concat([id3v1(), tag]),
    ]) {
      await expect(count(mp3([frame()], undefined, tail), 3)).rejects.toMatchObject({
        kind: 'invalid-mp3',
        message: 'Unexpected bytes after trailing metadata',
      });
    }
  });

  it('rejects incomplete appended headers, bodies, footers and final ID3v1', async () => {
    const tag = id3v2(Buffer.alloc(12), 4, true);
    for (const tail of [
      tag.subarray(0, 5),
      tag.subarray(0, 13),
      tag.subarray(0, tag.length - 1),
      Buffer.concat([tag, id3v1().subarray(0, 17)]),
    ]) {
      await expect(count(mp3([frame()], undefined, tail), 7)).rejects.toMatchObject({
        kind: 'truncated-mp3',
      });
    }
  });

  it('verifies every byte of an appended footer against its tag header', async () => {
    for (let index = 0; index < 10; index++) {
      const tag = id3v2(Buffer.alloc(12), 4, true);
      tag[tag.length - 10 + index] = tag[tag.length - 10 + index]! ^ 1;
      await expect(count(mp3([frame()], undefined, tag), 1)).rejects.toMatchObject({
        kind: 'invalid-mp3',
        message: 'Invalid ID3v2 footer',
      });
    }
  });

  it('does not confuse fake sync markers inside MPEG payload with real frames', async () => {
    const maliciousFrame = frame({ seed: 0xff });
    maliciousFrame.set([0xff, 0xfb, 0x90, 0x00], 12);
    expect(await count(mp3([maliciousFrame, frame()]), 3)).toBe(2);
  });

  it('allows frame headers and ID3 headers to span chunk boundaries', async () => {
    const bytes = mp3([frame({ hasCrc: true }), frame({ padding: 1 })], id3v2(Buffer.alloc(4)));
    expect(await count(bytes, 1)).toBe(2);
    expect(await count(bytes, 7)).toBe(2);
  });

  it('closes the upstream stream after early rejection', async () => {
    let closed = false;
    async function* input(): AsyncGenerator<Uint8Array> {
      try {
        yield Buffer.from('INVALID-MP3');
        // A real multipart file could still have megabytes left to transmit.
        yield Buffer.alloc(1024);
      } finally {
        closed = true;
      }
    }

    await expect(countMp3Frames(input())).rejects.toMatchObject({ kind: 'invalid-mp3' });
    expect(closed).toBe(true);
  });

  it('rejects streams with no byte progress rather than spinning indefinitely', async () => {
    let closed = false;
    async function* emptyChunks(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < 2_000; i++) yield new Uint8Array(0);
        yield frame();
      } finally {
        closed = true;
      }
    }
    await expect(countMp3Frames(emptyChunks())).rejects.toMatchObject({
      kind: 'invalid-mp3',
      message: 'Input stream made no progress',
    });
    expect(closed).toBe(true);
  });

  it('preserves the parse error when upstream cleanup also fails', async () => {
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          async next() {
            if (!sent) {
              sent = true;
              return { done: false as const, value: Buffer.from('not-an-mp3') };
            }
            return { done: true as const, value: undefined };
          },
          async return() {
            throw new Error('Upstream cleanup failed');
          },
        };
      },
    };
    await expect(countMp3Frames(source)).rejects.toMatchObject({ kind: 'invalid-mp3' });
  });

  it('preserves an upstream read error and releases the iterator without pulling again', async () => {
    const failure = new Error('Input stream was interrupted');
    let reads = 0;
    let releases = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (++reads === 1) return { done: false as const, value: frame() };
            throw failure;
          },
          async return() {
            releases++;
            throw new Error('Cleanup also failed');
          },
        };
      },
    };
    await expect(countMp3Frames(source)).rejects.toBe(failure);
    expect(reads).toBe(2);
    expect(releases).toBe(1);
  });

  it('propagates cancellation of a Node stream while waiting for further audio', async () => {
    const controller = new AbortController();
    let emitted = false;
    const source = new Readable({
      signal: controller.signal,
      read() {
        if (emitted) return;
        emitted = true;
        this.push(frame());
        setImmediate(() => controller.abort());
      },
    });
    try {
      await expect(countMp3Frames(source)).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
      expect(source.destroyed).toBe(true);
    } finally {
      source.destroy();
    }
  });

  it('rejects empty input, noise, and metadata-only input', async () => {
    await expect(count(Buffer.alloc(0))).rejects.toBeInstanceOf(Mp3ParseError);
    await expect(count(Buffer.from('Not an MP3 file'))).rejects.toMatchObject({
      kind: 'invalid-mp3',
    });
    await expect(count(id3v2(Buffer.alloc(100)))).rejects.toMatchObject({ kind: 'invalid-mp3' });
  });

  it('rejects a partial final frame and trailing garbage', async () => {
    const bytes = mp3([frame(), frame()]);
    await expect(count(bytes.subarray(0, bytes.length - 3))).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
    await expect(count(Buffer.concat([bytes, Buffer.from('trailing')]))).rejects.toMatchObject({
      kind: 'invalid-mp3',
    });
    await expect(count(Buffer.concat([bytes, Buffer.from([0xff, 0xfb])]))).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });

  it('rejects unsupported MPEG format', async () => {
    const unsupported = frame();
    unsupported[1] = 0xf3;
    await expect(count(unsupported)).rejects.toMatchObject({ kind: 'unsupported-format' });
  });

  it('reports free-format MPEG-1 Layer III as unsupported instead of corrupt', async () => {
    const freeFormatHeader = Buffer.from([0xff, 0xfb, 0, 0]);
    for (const prefix of [Buffer.alloc(0), frame()]) {
      await expect(count(Buffer.concat([prefix, freeFormatHeader]), 1)).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: prefix.length,
        message: 'Free-format MPEG-1 Layer III is not supported; use a table-defined bitrate',
      });
    }
  });

  it('rejects incomplete leading ID3 headers and ID3v2.4 footers', async () => {
    await expect(count(Buffer.from([0x49, 0x44, 0x33, 4, 0]))).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
    const valid = id3v2(Buffer.alloc(3), 4, true);
    await expect(count(valid.subarray(0, valid.length - 2))).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });

  it('rejects corrupt ID3v2 footer or truncated metadata', async () => {
    const badFooter = id3v2(Buffer.alloc(10), 4, true);
    badFooter[badFooter.length - 10] = 0;
    await expect(count(Buffer.concat([badFooter, frame()]))).rejects.toMatchObject({
      kind: 'invalid-mp3',
    });
    const incomplete = id3v2(Buffer.alloc(250));
    await expect(count(incomplete.subarray(0, 50))).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });

  it('requires an ID3v2.4 footer to match the original tag header', async () => {
    for (const footerByte of [3, 4, 5, 6, 7, 8, 9]) {
      const tag = id3v2(Buffer.alloc(8), 4, true);
      const footerOffset = tag.length - 10 + footerByte;
      tag[footerOffset] = tag[footerOffset]! ^ 1;
      await expect(count(mp3([frame()], tag))).rejects.toMatchObject({
        kind: 'invalid-mp3',
      });
    }
  });

  it('rejects unexpected bytes after ID3v1 and too many initial ID3v2 tags', async () => {
    await expect(
      count(mp3([frame()], undefined, Buffer.concat([id3v1(), frame()]))),
    ).rejects.toMatchObject({ kind: 'invalid-mp3' });
    const tooManyTags = Buffer.concat(Array.from({ length: 9 }, () => id3v2(Buffer.alloc(0))));
    await expect(count(mp3([frame()], tooManyTags))).rejects.toMatchObject({
      kind: 'invalid-mp3',
    });
  });

  it('accepts exactly the documented limit of eight leading ID3v2 tags', async () => {
    const tags = Buffer.concat(Array.from({ length: 8 }, () => id3v2(Buffer.alloc(12))));
    expect(await count(mp3([frame()], tags), 3)).toBe(1);
  });

  it.each([
    ['cbr.mp3', 33],
    ['vbr.mp3', 33],
    ['no-xing.mp3', 51],
  ])('counts a real LAME-encoded %s fixture', async (name, expectedCount) => {
    const bytes = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    expect(await count(bytes, 17)).toBe(expectedCount);
    expect(await count(bytes, 4096)).toBe(await count(bytes, 1));
  });
});
