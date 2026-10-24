import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, frame, mp3 } from './helpers/mp3-fixtures.js';

/** Independent structural fixture: MPEG-1 L3, free bitrate index and fixed base span. */
function freeFrame(base: number, padding = 0, rateIndex = 0, mono = true): Buffer {
  const length = base + padding;
  const buffer = Buffer.alloc(length, 0x11);
  buffer.set([0xff, 0xfb, (rateIndex << 2) | (padding << 1), mono ? 0xc4 : 0x04]);
  return buffer;
}
const count = (input: Uint8Array, size = 37, includeVbrHeaderFrame = true) =>
  countMp3Frames(chunks(input, [size]), { includeVbrHeaderFrame });

describe('free-format MPEG-1 Layer III', () => {
  it.each([0, 1, 2])('infers a fixed frame span at sample rate index %i', async (rateIndex) => {
    const bytes = mp3([0, 1, 0, 1, 1, 0].map((padding) => freeFrame(730, padding, rateIndex)));
    for (const chunkSize of [1, 13, 4096]) {
      await expect(count(bytes, chunkSize)).resolves.toBe(6);
    }
  });

  it.each([
    { rateIndex: 1, base: 384, label: '48 kHz at 128 kbps' },
    { rateIndex: 2, base: 576, label: '32 kHz at 128 kbps' },
    { rateIndex: 1, base: 864, label: '48 kHz at 288 kbps' },
  ])('infers a constant span without padding ($label)', async ({ rateIndex, base }) => {
    // Without padding variation, multiples of the true span also land on frame
    // boundaries. They visit fewer headers and must not count as a tie.
    const bytes = mp3(Array.from({ length: 24 }, () => freeFrame(base, 0, rateIndex, false)));
    for (const chunkSize of [7, 4096]) {
      await expect(count(bytes, chunkSize)).resolves.toBe(24);
    }
  });

  it('recognizes a real-sized 400 kbps free-format frame sequence', async () => {
    const bytes = mp3(Array.from({ length: 7 }, (_, i) => freeFrame(1306, i % 3 === 0 ? 1 : 0)));
    await expect(count(bytes, 127)).resolves.toBe(7);
  });

  it('includes an initial free-format Info frame by default and excludes it on request', async () => {
    const initial = freeFrame(730, 0);
    initial.write('Info', 21, 'ascii');
    initial.writeUInt32BE(0x00000003, 25);
    const bytes = mp3([initial, freeFrame(730), freeFrame(730, 1), freeFrame(730)]);
    await expect(count(bytes)).resolves.toBe(4);
    await expect(count(bytes, 7, false)).resolves.toBe(3);
  });

  it('does not select a single decoy MPEG sync inside a payload', async () => {
    const first = freeFrame(720);
    first.set([0xff, 0xfb, 0, 0xc4], 60);
    const bytes = mp3([first, freeFrame(720), freeFrame(720), freeFrame(720)]);
    await expect(count(bytes, 1)).resolves.toBe(4);
  });

  it('fails closed for ambiguous streams containing fewer than three headers', async () => {
    for (const bytes of [freeFrame(730), mp3([freeFrame(730), freeFrame(730)])]) {
      await expect(count(bytes)).rejects.toMatchObject({ kind: 'unsupported-format' });
    }
  });

  it('rejects free-format streams whose subsequent sample rate changes', async () => {
    const bytes = mp3([freeFrame(720), freeFrame(720), freeFrame(720), freeFrame(720)]);
    bytes[720 + 2] = 4;
    await expect(count(bytes)).rejects.toMatchObject({
      kind: 'unsupported-format',
    });
  });

  it('rejects truncated final free-format frames', async () => {
    const bytes = mp3(Array.from({ length: 5 }, () => freeFrame(800)));
    await expect(count(bytes.subarray(0, bytes.length - 5))).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
  });

  it('rejects mixing free-format and ordinary indexed frames', async () => {
    const free = mp3(Array.from({ length: 5 }, () => freeFrame(800)));
    await expect(count(mp3([frame(), free]))).rejects.toMatchObject({ kind: 'invalid-mp3' });
    await expect(count(mp3([free, frame()]))).rejects.toMatchObject({ kind: 'invalid-mp3' });
  });

  it('rejects inconsistent bitrate index after inferred free-format spacing', async () => {
    const input = mp3(Array.from({ length: 6 }, () => freeFrame(800)));
    input[5 * 800 + 2] = input[5 * 800 + 2]! | 0x90;
    await expect(count(input)).rejects.toMatchObject({ kind: 'invalid-mp3' });
  });
  it('rejects changes of free-format sample rate after successful frame inference', async () => {
    const blocks = Array.from({ length: 7 }, () => freeFrame(730));
    blocks[5]![2] = 4; // Beyond the three headers required to establish frame length.
    await expect(count(mp3(blocks), 1)).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: 5 * 730,
      message: 'Free-format sample rate changed',
    });
  });

  it('rejects competing equally plausible frame spacing candidates', async () => {
    // Two independent aligned patterns share only the first header. Neither is
    // authoritative, so choosing the first encountered candidate is incorrect.
    const buffer = Buffer.alloc(580, 0x11);
    for (const offset of [0, 240, 480, 260, 520]) {
      buffer.set([0xff, 0xfb, 0x00, 0xc4], offset);
    }
    await expect(count(buffer)).rejects.toMatchObject({
      kind: 'unsupported-format',
      message: 'Cannot infer a unique free-format MPEG frame size from consecutive headers',
    });
  });

  it('does not infer a free-format base outside the configured size range', async () => {
    const tooShort = Buffer.alloc(52, 0x11);
    tooShort.set([0xff, 0xfb, 2, 0xc4], 0); // Initial padding makes 24 -> base 23.
    tooShort.set([0xff, 0xfb, 0, 0xc4], 24);
    await expect(count(tooShort)).rejects.toMatchObject({ kind: 'unsupported-format' });

    const tooLong = Buffer.alloc(2_885, 0x11);
    tooLong.set([0xff, 0xfb, 0, 0xc4], 0);
    tooLong.set([0xff, 0xfb, 0, 0xc4], 2_881); // Base 2881 exceeds bound.
    await expect(count(tooLong)).rejects.toMatchObject({ kind: 'unsupported-format' });
  });

  it('rejects plausible but nonconsecutive free-format syncs within a frame', async () => {
    const bytes = Buffer.alloc(600, 0x11);
    for (const offset of [0, 130, 390]) bytes.set([0xff, 0xfb, 0, 0xc4], offset);
    await expect(count(bytes)).rejects.toMatchObject({ kind: 'unsupported-format' });
  });
});
