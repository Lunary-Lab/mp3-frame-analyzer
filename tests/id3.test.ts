import { describe, expect, it } from 'vitest';
import { hasPossibleMetadataPrefix } from '../src/mp3/id3.js';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, frame, id3v1, id3v2, mp3, synchsafe } from './helpers/mp3-fixtures.js';

const count = (bytes: Uint8Array, size = 7) => countMp3Frames(chunks(bytes, [size]));

/** A valid tag first, so a failure inside the second tag reports a nonzero offset. */
const afterFirstTag = (tag: Buffer) => {
  const first = id3v2(Buffer.alloc(5));
  return { bytes: mp3([frame()], Buffer.concat([first, tag])), offset: first.length };
};

describe('ID3 tag headers', () => {
  it.each([2, 3, 4] as const)('skips an ID3v2.%i tag by its synchsafe length', async (version) => {
    await expect(count(mp3([frame()], id3v2(Buffer.alloc(16385), version)))).resolves.toBe(1);
  });

  it('skips a leading ID3v2.4 tag with its footer', async () => {
    await expect(count(mp3([frame()], id3v2(Buffer.alloc(12), 4, true)))).resolves.toBe(1);
  });

  it('decodes the size from four synchsafe header bytes, not from the tag body', async () => {
    const body = Buffer.from([0x80, 0x80, 0xff, 0xfb]);
    await expect(count(mp3([frame()], id3v2(body, 4)), 1)).resolves.toBe(1);
  });

  it('produces 28-bit synchsafe big-endian fixture values', () => {
    expect([...synchsafe(0x12345)]).toEqual([0, 4, 70, 69]);
  });

  it.each([0, 1, 5, 255])('rejects unsupported ID3v2 major version %i', async (version) => {
    const tag = id3v2(Buffer.alloc(1));
    tag[3] = version;
    const { bytes, offset } = afterFirstTag(tag);
    await expect(count(bytes)).rejects.toMatchObject({
      kind: 'unsupported-format',
      offset,
      message: 'Unsupported ID3v2 version',
    });
  });

  it('rejects ID3v2 revision 0xff but accepts other revisions', async () => {
    const invalid = id3v2(Buffer.alloc(1), 4);
    invalid[4] = 0xff;
    const { bytes, offset } = afterFirstTag(invalid);
    await expect(count(bytes)).rejects.toMatchObject({
      kind: 'unsupported-format',
      offset,
      message: 'Unsupported ID3v2 version',
    });
    const valid = id3v2(Buffer.alloc(1), 4);
    valid[4] = 0xfe;
    await expect(count(mp3([frame()], valid))).resolves.toBe(1);
  });

  it.each([
    [2, 0x20],
    [3, 0x10],
    [4, 0x01],
  ] as const)('rejects reserved flag bits in an ID3v2.%i header', async (version, flag) => {
    const tag = id3v2(Buffer.alloc(1), version);
    tag[5] = flag;
    const { bytes, offset } = afterFirstTag(tag);
    await expect(count(bytes)).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset,
      message: 'Reserved ID3v2 flags are set',
    });
  });

  it('allows the experimental flag defined by ID3v2.3', async () => {
    const tag = id3v2(Buffer.alloc(1), 3);
    tag[5] = 0x20;
    await expect(count(mp3([frame()], tag))).resolves.toBe(1);
  });

  it.each([6, 7, 8, 9])('rejects a set high bit in synchsafe size byte %i', async (index) => {
    const tag = id3v2(Buffer.alloc(1));
    tag[index] = 0x80;
    const { bytes, offset } = afterFirstTag(tag);
    await expect(count(bytes)).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: offset + index,
      message: 'Invalid synchsafe ID3v2 size',
    });
  });

  it('requires all three ID3v2 signature bytes', async () => {
    for (const signature of ['XD3', 'IX3', 'IDX', 'ID4', 'I33']) {
      const lookalike = Buffer.concat([Buffer.from(signature), Buffer.alloc(8)]);
      await expect(count(mp3([frame()], lookalike))).rejects.toMatchObject({
        kind: 'invalid-mp3',
        offset: 0,
        message: 'Invalid MPEG-1 Layer III frame header',
      });
    }
  });

  it('recognizes a trailing ID3v1 tag by exactly its TAG prefix', async () => {
    await expect(count(mp3([frame()], undefined, id3v1()))).resolves.toBe(1);
    for (const prefix of ['XAG', 'TBG', 'TAH']) {
      const lookalike = id3v1();
      lookalike.write(prefix, 0, 'ascii');
      await expect(count(mp3([frame()], undefined, lookalike))).rejects.toMatchObject({
        kind: 'invalid-mp3',
        offset: frame().length,
        message: 'Invalid MPEG-1 Layer III frame header',
      });
    }
  });
});

it('retains the shared conservative metadata-prefix predicate for TAG and nonmetadata', () => {
  expect(hasPossibleMetadataPrefix(Buffer.from('TAG'), 128)).toBe(true);
  expect(hasPossibleMetadataPrefix(Buffer.from('TAG'), 129)).toBe(false);
  expect(hasPossibleMetadataPrefix(Buffer.from('not metadata'), 3)).toBe(false);
});

it.each([
  { name: 'empty bytes', bytes: [] },
  { name: 'one signature byte', bytes: [0x49] },
  { name: 'two signature bytes', bytes: [0x49, 0x44] },
  { name: 'wrong first byte', bytes: [0, 0x44, 0x33] },
  { name: 'wrong second byte', bytes: [0x49, 0, 0x33] },
  { name: 'wrong third byte', bytes: [0x49, 0x44, 0] },
  { name: 'plausible fields without ID3', bytes: [0, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0] },
])('requires the complete ID3 signature for prefix evidence: $name', ({ bytes }) => {
  expect(hasPossibleMetadataPrefix(Uint8Array.from(bytes), 0)).toBe(false);
  expect(hasPossibleMetadataPrefix(Buffer.from('ID3'), 0)).toBe(true);
});
