import { readFile } from 'node:fs/promises';
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

  it('rejects unexpected bytes after ID3v1 and too many initial ID3v2 tags', async () => {
    await expect(count(mp3([frame()], undefined, Buffer.concat([id3v1(), frame()])))).rejects.toMatchObject({
      kind: 'invalid-mp3',
    });
    await expect(count(mp3([frame()], Buffer.concat(Array.from({ length: 9 }, () => id3v2(Buffer.alloc(0))))))).rejects.toMatchObject({
      kind: 'invalid-mp3',
    });
  });

  it.each(['cbr.mp3', 'vbr.mp3'])('accepts a real LAME-encoded %s fixture', async (name) => {
    const bytes = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    expect(await count(bytes, 17)).toBe(33);
    expect(await count(bytes, 4096)).toBe(await count(bytes, 1));
  });
});
