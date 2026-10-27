import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, multipartBody } from './helpers/mp3-fixtures.js';
import { metadataTag } from './helpers/metadata-fixtures.js';

// Original silent structural frames, not bytes copied from a standard or a
// decoder fixture. Zero side information removes reservoir/main-data use.
// Known construction boundaries are an oracle only where the stated bounded
// inference policy distinguishes them; the ambiguity witness below has TWO
// admissible constructions and deliberately has no expected numeric count.
const rates = [44_100, 48_000, 32_000] as const;
type Mode = 'indexed' | 'free';
function silentFrame(rateIndex: number, mode: Mode, padding = 0): Buffer {
  const kbps = mode === 'free' ? 72 : 128;
  const length = Math.floor((144_000 * kbps) / rates[rateIndex]!) + padding;
  const bytes = Buffer.alloc(length);
  bytes.set([
    0xff,
    0xfb,
    (mode === 'indexed' ? 0x90 : 0) | (rateIndex << 2) | (padding << 1),
    0xc0,
  ]);
  return bytes;
}
function sequence(rateIndex: number, mode: Mode, count: number): Buffer {
  return Buffer.concat(
    Array.from({ length: count }, (_, index) =>
      silentFrame(rateIndex, mode, rateIndex === 0 && index % 2 === 1 ? 1 : 0),
    ),
  );
}
const count = (input: Uint8Array, sizes: number[]) => countMp3Frames(chunks(input, sizes));
const cases = [0, 1, 2].flatMap((firstRate) =>
  [0, 1, 2]
    .filter((nextRate) => nextRate !== firstRate)
    .flatMap((nextRate) =>
      (['indexed', 'free'] as const).flatMap((firstMode) =>
        (['indexed', 'free'] as const).flatMap((nextMode) =>
          [2, 3, 7].map((prefix) => ({ firstRate, nextRate, firstMode, nextMode, prefix })),
        ),
      ),
    ),
);

describe('successive MPEG-1 Layer III configurations in ONE byte stream', () => {
  it.each(cases)(
    '$prefix $firstMode frames at rate index $firstRate then $nextMode at $nextRate',
    async ({ firstRate, nextRate, firstMode, nextMode, prefix }) => {
      const input = Buffer.concat([
        sequence(firstRate, firstMode, prefix),
        sequence(nextRate, nextMode, 7),
      ]);
      for (const sizes of [[1], [2, 3, 5, 97], [input.length]]) {
        if (
          firstMode === 'free' &&
          nextMode === 'free' &&
          firstRate === 2 &&
          nextRate === 1 &&
          prefix === 7
        ) {
          // Zero-data bytes also admit three 972-byte 32 kHz frames followed
          // by four 216-byte 48 kHz frames. Construction count 14 is not unique.
          await expect(count(input, sizes)).rejects.toMatchObject({
            kind: 'unsupported-format',
            message: 'Ambiguous free-format MPEG frame layout',
          });
        } else {
          await expect(count(input, sizes)).resolves.toBe(prefix + 7);
        }
      }
    },
  );

  it.each(['indexed', 'free'] as const)(
    'accepts a single indexed leading frame before changed-rate %s',
    async (nextMode) => {
      const input = Buffer.concat([sequence(1, 'indexed', 1), sequence(2, nextMode, 7)]);
      for (const sizes of [[1], [input.length]]) await expect(count(input, sizes)).resolves.toBe(8);
    },
  );

  it('reports the 864-byte one-frame versus three-frame layout as ambiguity', async () => {
    const input = Buffer.concat([sequence(1, 'free', 1), sequence(2, 'free', 2)]);
    expect(input.length).toBe(864);
    // Alternative A: 216 + 324 + 324 bytes, two sample-rate configurations.
    // Alternative B: one 864-byte free-format 48 kHz / 288 kbps frame with
    // the two later header patterns in its unconstrained ancillary bytes.
    expect((144_000 * 288) / rates[1]).toBe(input.length);
    for (const sizes of [[1], [2, 3, 5], [input.length]]) {
      await expect(count(input, sizes)).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: 0,
        message: 'Ambiguous free-format MPEG frame layout',
      });
    }
  });

  it('does not use a changed-rate indexed header with an incomplete span as sequence evidence', async () => {
    const input = silentFrame(1, 'free');
    // A complete-looking indexed header needs 576 bytes at 32 kHz, but only
    // 116 bytes remain. It cannot form a competing complete successor frame.
    input.set(silentFrame(2, 'indexed').subarray(0, 4), 100);
    for (const sizes of [[1], [input.length]]) await expect(count(input, sizes)).resolves.toBe(1);
  });

  it('does not use a changed-rate free header without its mandatory prefix as sequence evidence', async () => {
    const input = silentFrame(1, 'free');
    input.set(silentFrame(2, 'free').subarray(0, 4), input.length - 20);
    for (const sizes of [[1], [input.length]]) await expect(count(input, sizes)).resolves.toBe(1);
  });

  it('keeps validated metadata separate from the changed-rate span state', async () => {
    const input = Buffer.concat([sequence(1, 'free', 2), metadataTag(3), sequence(2, 'free', 3)]);
    for (const sizes of [[1], [input.length]]) await expect(count(input, sizes)).resolves.toBe(5);
  });

  it('handles repeated resolved rate changes without keeping an old free span', async () => {
    const input = Buffer.concat([
      sequence(1, 'free', 3),
      sequence(2, 'indexed', 3),
      sequence(0, 'free', 3),
      sequence(1, 'indexed', 3),
    ]);
    for (const sizes of [[1], [input.length]]) await expect(count(input, sizes)).resolves.toBe(12);
  });
});

it.each(
  [0, 1, 2].flatMap((firstRate) =>
    [0, 1, 2]
      .filter((nextRate) => nextRate !== firstRate)
      .flatMap((nextRate) =>
        (['indexed', 'free'] as const).map((nextMode) => ({ firstRate, nextRate, nextMode })),
      ),
  ),
)(
  'does not guess a single leading free span at $firstRate before $nextMode/$nextRate',
  async ({ firstRate, nextRate, nextMode }) => {
    const input = Buffer.concat([sequence(firstRate, 'free', 1), sequence(nextRate, nextMode, 7)]);
    for (const sizes of [[1], [input.length]])
      await expect(count(input, sizes)).rejects.toMatchObject({
        kind: 'unsupported-format',
        offset: 0,
        message: 'Ambiguous free-format MPEG frame layout',
      });
  },
);

it.each([0, 1, 2, 3].flatMap((mode) => [false, true].map((crc) => ({ mode, crc }))))(
  'retains mandatory prefix bytes at new-sequence evidence: mode=$mode CRC=$crc',
  async ({ mode, crc }) => {
    const length = 4 + (crc ? 2 : 0) + (mode === 3 ? 17 : 32);
    const first = Buffer.alloc(length);
    first.set([255, crc ? 250 : 251, 4, mode << 6]);
    const input = Buffer.concat([first, first, sequence(2, 'indexed', 3)]);
    for (const sizes of [[1], [input.length]]) await expect(count(input, sizes)).resolves.toBe(5);
  },
);

it.each([
  { header: [255, 251, 0xfc, 192], kind: 'invalid-mp3' },
  { header: [255, 243, 0x98, 192], kind: 'unsupported-format' },
  { header: [255, 253, 0x98, 192], kind: 'unsupported-format' },
  { header: [255, 251, 0x98], kind: 'truncated-mp3' },
])('keeps $kind classification at an established boundary', async ({ header, kind }) => {
  const prefix = sequence(1, 'indexed', 2);
  const input = Buffer.concat([prefix, Buffer.from(header)]);
  for (const sizes of [[1], [input.length]])
    await expect(count(input, sizes)).rejects.toMatchObject({
      kind,
      offset: prefix.length,
    });
});

it('keeps a truncated new indexed frame distinct from an unsupported free inference', async () => {
  const prefix = sequence(1, 'free', 3);
  const input = Buffer.concat([prefix, silentFrame(2, 'indexed').subarray(0, 100)]);
  for (const sizes of [[1], [input.length]])
    await expect(count(input, sizes)).rejects.toMatchObject({
      kind: 'truncated-mp3',
    });
});

it('preserves direct physical count and HTTP initial-only encoder-header exclusion', async () => {
  const first = sequence(1, 'indexed', 3);
  first.write('Info', 21, 'ascii');
  const second = sequence(2, 'free', 3);
  second.write('Info', 21, 'ascii');
  const input = Buffer.concat([first, second]);
  await expect(count(input, [1])).resolves.toBe(6);
  const app = await buildApp();
  try {
    for (const query of ['', '?includeVbrHeaderFrame=false', '?includeVbrHeaderFrame=true']) {
      const multipart = multipartBody(input);
      for (const form of [{ contentType: 'audio/mpeg', payload: input }, multipart]) {
        const response = await app.inject({
          method: 'POST',
          url: '/file-upload' + query,
          headers: { 'content-type': form.contentType },
          payload: form.payload,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ frameCount: query.endsWith('true') ? 6 : 5 });
      }
    }
    const ambiguous = Buffer.concat([sequence(1, 'free', 1), sequence(2, 'free', 2)]);
    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': 'audio/mpeg' },
      payload: ambiguous,
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: 'unsupported-format',
      message: 'Ambiguous free-format MPEG frame layout',
    });
  } finally {
    await app.close();
  }
});

it('uses an open indexed successor chain without treating the probe end as EOF', async () => {
  const input = Buffer.concat([sequence(1, 'free', 2), sequence(2, 'indexed', 30)]);
  for (const sizes of [[1], [4096], [input.length]])
    await expect(count(input, sizes)).resolves.toBe(32);
});

it('anchors a short prefix before an indexed successor and a large streamed tag', async () => {
  const input = Buffer.concat([
    sequence(1, 'free', 2),
    sequence(2, 'indexed', 1),
    metadataTag(3, { padding: 10_000 }),
    sequence(2, 'indexed', 1),
  ]);
  for (const sizes of [[1], [4096], [input.length]])
    await expect(count(input, sizes)).resolves.toBe(4);
});

it('uses a supported free successor after one indexed frame within the probe', async () => {
  const input = Buffer.concat([
    sequence(1, 'free', 2),
    sequence(2, 'indexed', 1),
    sequence(0, 'free', 40),
  ]);
  for (const sizes of [[1], [4096], [input.length]])
    await expect(count(input, sizes)).resolves.toBe(43);
});

it('does not let a malformed tag become indexed continuation evidence', async () => {
  const prefix = Buffer.concat([sequence(1, 'free', 3), sequence(2, 'indexed', 1)]);
  const invalid = metadataTag(4);
  invalid[5] = 1;
  const input = Buffer.concat([prefix, invalid]);
  for (const sizes of [[1], [input.length]])
    await expect(count(input, sizes)).rejects.toMatchObject({
      kind: 'invalid-mp3',
      offset: prefix.length,
      message: 'Reserved ID3v2 flags are set',
    });
});
