import { array, assert, asyncProperty, boolean, constantFrom, integer, record } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, frame } from './helpers/mp3-fixtures.js';
import { metadataTag, metadataV1, type Id3Version } from './helpers/metadata-fixtures.js';

const partitions = [[1], [2, 3, 5, 7], [9, 10, 11, 127, 128], [65_536]];
const count = (bytes: Uint8Array, sizes: readonly number[] = [7]) =>
  countMp3Frames(chunks(bytes, sizes));

// Expected counts come from construction, never from the parser or tag-declared counts.
describe('source-backed ID3 layouts', () => {
  it.each([2, 3, 4] as const)('counts audio surrounding embedded ID3v2.%i', async (version) => {
    const audio = [frame(), frame({ hasCrc: true, padding: 1 })];
    const tag = metadataTag(version);
    const intro = metadataTag(version, { embedded: true });
    for (const sizes of partitions) {
      expect(await count(Buffer.concat([intro, audio[0]!, tag, audio[1]!]), sizes)).toBe(2);
    }
  });

  it.each([false, true])('accepts an embedded v2.4 footer=%s, then more audio', async (footer) => {
    const bytes = Buffer.concat([frame(), metadataTag(4, { footer }), frame()]);
    for (const sizes of partitions) expect(await count(bytes, sizes)).toBe(2);
  });

  it.each([undefined, 1, 255])(
    'accepts repeated appended update tags before ID3v1 track=%s',
    async (track) => {
      const tail = [
        metadataTag(4, { footer: true }),
        metadataTag(4, { footer: true, extended: true, update: true }),
      ];
      for (const sizes of partitions) {
        expect(await count(Buffer.concat([frame(), ...tail]), sizes)).toBe(1);
        expect(await count(Buffer.concat([frame(), ...tail, metadataV1(track)]), sizes)).toBe(1);
      }
    },
  );

  it('accepts the recommended prepend/append pair with an accurate SEEK record', async () => {
    const audio = [frame(), frame({ padding: 1 })];
    const embedded = metadataTag(4, { seek: audio[1]!.length });
    const leading = metadataTag(4, { seek: audio[0]!.length });
    const appended = metadataTag(4, { footer: true, extended: true, update: true });
    const bytes = Buffer.concat([leading, audio[0]!, embedded, audio[1]!, appended, metadataV1(7)]);
    // SEEK's unsigned 32-bit offset is measured from this tag's end to the
    // next tag's beginning (ID3v2.4 Frames §4.29), not past intervening tags.
    const nextFromLeading = leading.length + leading.readUInt32BE(leading.indexOf('SEEK') + 10);
    expect(nextFromLeading).toBe(leading.length + audio[0]!.length);
    const nextFromEmbedded =
      nextFromLeading + embedded.length + embedded.readUInt32BE(embedded.indexOf('SEEK') + 10);
    expect(nextFromEmbedded).toBe(bytes.length - metadataV1(7).length - appended.length);
    expect(bytes.subarray(nextFromLeading, nextFromLeading + embedded.length)).toEqual(embedded);
    expect(bytes.subarray(nextFromEmbedded, nextFromEmbedded + appended.length)).toEqual(appended);
    for (const sizes of partitions) expect(await count(bytes, sizes)).toBe(2);
  });

  it('covers defined flags, rates, channels, CRC and padding at supported placements', async () => {
    for (const version of [2, 3, 4] as const) {
      for (const unsync of [false, true]) {
        for (const extended of version === 2 ? [false] : [false, true]) {
          for (const experimental of version === 2 ? [false] : [false, true]) {
            for (const footer of version === 4 ? [false, true] : [false]) {
              const options = { unsync, extended, experimental, footer, padding: footer ? 0 : 257 };
              const tag = metadataTag(version, options);
              for (let mode = 0; mode < 4; mode++) {
                for (const hasCrc of [false, true]) {
                  for (const padding of [0, 1] as const) {
                    for (const sampleRateIndex of [0, 1, 2]) {
                      const audio = frame({ hasCrc, padding, sampleRateIndex });
                      audio[3] = mode << 6;
                      const before = footer
                        ? metadataTag(4, { ...options, seek: audio.length })
                        : tag;
                      const bytes = Buffer.concat([
                        before,
                        audio,
                        before,
                        audio,
                        ...(footer ? [tag] : []),
                        metadataV1(3),
                      ]);
                      expect(await count(bytes, [1, 10, 128, 9])).toBe(2);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it.each([0x40, 0xc0])(
    'skips opaque v2.2 compressed-tag envelopes with flags %i',
    async (flags) => {
      // The author spec defines no compression scheme and instructs readers to
      // ignore the whole tag. This asserts only its outer envelope, not decoded records.
      const opaque = metadataTag(2);
      opaque[5] = flags;
      expect(await count(Buffer.concat([opaque, frame(), opaque, frame()]))).toBe(2);
    },
  );

  it('streams more than eight tags at leading, embedded and appended boundaries', async () => {
    for (const number of [9, 32, 300]) {
      const tag = metadataTag(4, { footer: true });
      const run = Buffer.concat(Array.from({ length: number }, () => tag));
      const bytes = Buffer.concat([run, frame(), run, frame(), run, metadataV1()]);
      let pulled = 0;
      async function* source() {
        for (const byte of bytes) {
          pulled++;
          yield Uint8Array.of(byte);
        }
      }
      expect(await countMp3Frames(source())).toBe(2);
      expect(pulled).toBe(bytes.length); // Exactly one forward read, independent of tag count.
      await expect(count(Buffer.concat([run, frame(), run.subarray(0, -1)]))).rejects.toMatchObject(
        { kind: 'truncated-mp3' },
      );
    }
  });

  it('requires every tag after the final audio frame to carry a v2.4 footer', async () => {
    for (const version of [2, 3, 4] as const) {
      const plain = metadataTag(version);
      const footer = metadataTag(4, { footer: true });
      for (const tail of [[plain], [plain, footer], [footer, plain], [plain, metadataV1()]]) {
        await expect(count(Buffer.concat([frame(), ...tail]))).rejects.toMatchObject({
          kind: 'invalid-mp3',
          message: 'Appended ID3v2 tags must use version 2.4 with a footer',
        });
      }
    }
  });

  it('does not accept repeated, leading or embedded ID3v1', async () => {
    for (const bytes of [
      Buffer.concat([metadataV1(), frame()]),
      Buffer.concat([frame(), metadataV1(), frame()]),
      Buffer.concat([frame(), metadataV1(), metadataV1()]),
    ]) {
      await expect(count(bytes)).rejects.toMatchObject({ kind: 'invalid-mp3' });
    }
  });

  it('never scans metadata signatures inside a declared MPEG payload', async () => {
    const audio = frame({ seed: 0x11 });
    audio.set(metadataTag(4, { footer: true }), 50);
    audio.set(metadataV1(), 150);
    for (const sizes of partitions)
      expect(await count(Buffer.concat([audio, frame()]), sizes)).toBe(2);
  });

  it('requires all bytes of embedded tag headers, bodies and footers', async () => {
    const tag = metadataTag(4, { footer: true, extended: true });
    for (let length = 3; length < tag.length; length++) {
      await expect(
        count(Buffer.concat([frame(), tag.subarray(0, length)]), [1]),
      ).rejects.toMatchObject({ kind: 'truncated-mp3' });
    }
    for (let byte = 0; byte < 10; byte++) {
      const changed = Buffer.from(tag);
      changed[changed.length - 10 + byte] = changed[changed.length - 10 + byte]! ^ 1;
      await expect(count(Buffer.concat([frame(), changed, frame()]))).rejects.toMatchObject({
        kind: 'invalid-mp3',
        message: 'Invalid ID3v2 footer',
      });
    }
  });

  it('preserves framing errors and mode across embedded metadata', async () => {
    const tag = metadataTag(3);
    const unsupported = frame();
    unsupported[1] = 0xf3;
    await expect(count(Buffer.concat([frame(), tag, unsupported]))).rejects.toMatchObject({
      kind: 'unsupported-format',
    });
    await expect(
      count(Buffer.concat([frame(), tag, frame().subarray(0, 50)])),
    ).rejects.toMatchObject({ kind: 'truncated-mp3' });
  });

  it('insertion and repartition preserve independently constructed indexed counts (seed 0x1d324)', async () => {
    await assert(
      asyncProperty(
        array(
          record({
            version: constantFrom<Id3Version>(2, 3, 4),
            padding: boolean(),
            crc: boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        array(integer({ min: 1, max: 129 }), { minLength: 1, maxLength: 8 }),
        async (specs, sizes) => {
          const body = specs.flatMap(({ version, padding, crc }) => {
            const audio = frame({ padding: padding ? 1 : 0, hasCrc: crc });
            return [metadataTag(version, version === 4 ? { seek: audio.length } : {}), audio];
          });
          const bytes = Buffer.concat([...body, metadataTag(4, { footer: true }), metadataV1(1)]);
          expect(await count(bytes, sizes)).toBe(specs.length);
        },
      ),
      { seed: 0x1d324, numRuns: 100 },
    );
  });
});
