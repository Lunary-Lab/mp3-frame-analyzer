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

  it('uses exact EOF closure for unambiguous one- and two-frame streams', async () => {
    expect(await count(freeFrame(730))).toBe(1);
    expect(await count(mp3([freeFrame(730), freeFrame(730)]))).toBe(2);
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
    await expect(count(mp3([frame(), free]))).rejects.toMatchObject({
      kind: 'invalid-mp3',
      message: 'Cannot mix free-format and indexed MPEG frames',
    });
    await expect(count(mp3([free, frame()]))).rejects.toMatchObject({
      kind: 'invalid-mp3',
      message: 'Cannot mix indexed and free-format MPEG frames',
    });
  });

  it.each([
    [
      'an invalid',
      Buffer.from([0x12, 0x34, 0x56, 0x78]),
      'invalid-mp3',
      'Invalid MPEG-1 Layer III frame header',
    ],
    [
      'a forbidden-bitrate MPEG-1 Layer III',
      Buffer.from([0xff, 0xfb, 0xf0, 0xc4]),
      'invalid-mp3',
      'Invalid MPEG-1 Layer III frame header',
    ],
    [
      'an MPEG-2',
      Buffer.from([0xff, 0xf3, 0x90, 0xc4]),
      'unsupported-format',
      'Only MPEG-1 Layer III is supported',
    ],
    [
      'an MPEG-1 Layer II',
      Buffer.from([0xff, 0xfd, 0x90, 0xc4]),
      'unsupported-format',
      'Only MPEG-1 Layer III is supported',
    ],
  ] as const)(
    'reports %s header after free-format frames as itself, not as mixing',
    async (_, header, kind, message) => {
      const frames = Array.from({ length: 4 }, () => freeFrame(800));
      const restOfFrame = Buffer.alloc(400, 0x11);
      const bytes = mp3([...frames, header, restOfFrame]);
      for (const chunkSize of [1, 4096]) {
        await expect(count(bytes, chunkSize)).rejects.toMatchObject({
          kind,
          offset: 3_200,
          message,
        });
      }
    },
  );

  it('accepts a three-header acquisition chain ending at EOF', async () => {
    await expect(count(mp3([freeFrame(730), freeFrame(730), freeFrame(730)]))).resolves.toBe(3);
  });

  it('accepts the smallest and largest supported spans', async () => {
    await expect(count(mp3(Array.from({ length: 4 }, () => freeFrame(21))))).resolves.toBe(4);
    // A padded 2,881-byte first frame puts the second header at the last candidate offset.
    const largest = mp3(Array.from({ length: 4 }, () => freeFrame(2_880, 1)));
    await expect(count(largest, 4096)).resolves.toBe(4);
  });

  it('rejects spans just outside the supported range despite consecutive headers', async () => {
    const belowMinimum = mp3([freeFrame(19, 1), freeFrame(19), freeFrame(19)]);
    await expect(count(belowMinimum)).rejects.toMatchObject({ kind: 'unsupported-format' });
    const aboveMaximum = mp3(Array.from({ length: 3 }, () => freeFrame(2_881)));
    await expect(count(aboveMaximum, 4096)).rejects.toMatchObject({ kind: 'unsupported-format' });
  });

  it('sees the fourth maximum-size header at the probe edge over a shorter payload chain', async () => {
    // The probe holds three maximum frames plus one header. The genuine chain
    // then has four headers, outweighing a three-header decoy chain in frame 0.
    const frames = Array.from({ length: 5 }, () => freeFrame(2_880, 1));
    for (const offset of [1_000, 2_000]) frames[0]!.set([0xff, 0xfb, 0x02, 0xc4], offset);
    await expect(count(mp3(frames), 4096)).resolves.toBe(5);
  });

  it('rejects inconsistent bitrate index after inferred free-format spacing', async () => {
    const input = mp3(Array.from({ length: 6 }, () => freeFrame(800)));
    input[5 * 800 + 2] = input[5 * 800 + 2]! | 0x90;
    await expect(count(input)).rejects.toMatchObject({ kind: 'invalid-mp3' });
  });
  it('reports ambiguous one-frame rate changes after successful frame inference', async () => {
    const blocks = Array.from({ length: 7 }, () => freeFrame(730));
    // The changed-rate alternative must have possible side information;
    // the generic 0x11 filler transmits a reserved switched block type zero.
    for (const block of blocks) block.fill(0, 4, 21);
    blocks[5]![2] = 4; // Beyond the initial three-header acquisition chain.
    await expect(count(mp3(blocks), 1)).rejects.toMatchObject({
      kind: 'unsupported-format',
      offset: 5 * 730,
      message: 'Ambiguous free-format MPEG frame layout',
    });
  });

  it.each([
    ['a header cut off at the end of the stream', [0xff, 0xfb, 0x00]],
    ['an indexed header at the same sample rate', [0xff, 0xfb, 0x90, 0xc4]],
  ])('does not extend a candidate span with %s', async (_, lastHeader) => {
    // Spans 100 and 140 each chain three free-format headers: a tie that must
    // fail closed. Counting the header at offset 300 would let span 100 win.
    const bytes = Buffer.alloc(300 + lastHeader.length, 0x11);
    for (const offset of [0, 100, 200, 140, 280]) bytes.set([0xff, 0xfb, 0x00, 0xc4], offset);
    bytes.set(lastHeader, 300);
    await expect(count(bytes, 4096)).rejects.toMatchObject({
      kind: 'unsupported-format',
      message: 'Ambiguous free-format MPEG frame layout',
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
      message: 'Ambiguous free-format MPEG frame layout',
    });
  });

  it('does not infer a free-format base outside the configured size range', async () => {
    const tooShort = Buffer.alloc(40, 0x11);
    tooShort.set([0xff, 0xfb, 2, 0xc4], 0); // Initial padding makes 20 -> base 19.
    tooShort.set([0xff, 0xfb, 0, 0xc4], 20);
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

// RFC 5219 section 3: MPEG-1 Layer III has a 4-byte header, optional 2-byte
// CRC, and 17 mono / 32 nonmono side-information bytes in this same frame.
// These short fixtures check only that mandatory prefix's available space;
// they do not assert valid compressed audio or CRC contents.
function prefixFrame(length: number, channelMode: number, crc = false, padding = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, crc ? 0xfa : 0xfb, 0x04 | (padding << 1), channelMode << 6]);
  return bytes;
}

async function countPrefixFrames(
  blocks: readonly Uint8Array[],
  chunkSize: number,
): Promise<number> {
  const bytes = Buffer.concat(blocks);
  async function* input() {
    for (let position = 0; position < bytes.length; position += chunkSize) {
      yield bytes.subarray(position, position + chunkSize);
    }
  }
  return countMp3Frames(input());
}

it.each(
  [0, 1, 2].flatMap((mode) =>
    (
      [
        [24, false],
        [35, false],
        [36, true],
        [37, true],
      ] as const
    ).flatMap(([length, crc]) => [1, 127].map((chunkSize) => ({ mode, length, crc, chunkSize }))),
  ),
)(
  'rejects mode $mode length $length CRC $crc in $chunkSize-byte chunks',
  async ({ mode, length, crc, chunkSize }) => {
    await expect(
      countPrefixFrames(
        Array.from({ length: 3 }, () => prefixFrame(length, mode, crc)),
        chunkSize,
      ),
    ).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: 0,
      message: 'Free-format frame is smaller than its header and side information',
    });
  },
);

it.each([0, 1, 2, 3])('preserves complete mandatory prefixes for mode %i', async (mode) => {
  for (const crc of [false, true]) {
    const length = (mode === 3 ? 21 : 36) + (crc ? 2 : 0);
    for (const chunkSize of [1, 127]) {
      await expect(
        countPrefixFrames(
          Array.from({ length: 3 }, () => prefixFrame(length, mode, crc)),
          chunkSize,
        ),
      ).resolves.toBe(3);
    }
  }
});

it('rechecks side-information space when channel mode changes after acquisition', async () => {
  const blocks = [...Array.from({ length: 5 }, () => prefixFrame(24, 3)), prefixFrame(24, 0)];
  await expect(countPrefixFrames(blocks, 1)).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: 120,
    message: 'Free-format frame is smaller than its header and side information',
  });
});

it('rechecks CRC space when protection changes after acquisition', async () => {
  const blocks = [...Array.from({ length: 5 }, () => prefixFrame(36, 0)), prefixFrame(36, 0, true)];
  await expect(countPrefixFrames(blocks, 127)).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: 180,
    message: 'Free-format frame is smaller than its header and side information',
  });
});

it('checks the actual padded frame length, not just the cached base', async () => {
  const padded = Array.from({ length: 5 }, () => prefixFrame(36, 0, false, 1));
  await expect(countPrefixFrames(padded, 1)).resolves.toBe(5);
  await expect(countPrefixFrames([...padded, prefixFrame(35, 0)], 127)).rejects.toMatchObject({
    kind: 'invalid-mp3',
    offset: 180,
    message: 'Free-format frame is smaller than its header and side information',
  });
});
