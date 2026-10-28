import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../../src/mp3/count-frames.js';
import { chunks } from '../helpers/mp3-fixtures.js';

interface EncoderFixture {
  name: string;
  bitrate: number;
  base64: string;
  sha256: string;
  bytes: number;
  audioFrames: number;
  physicalFrames: number;
}

// Fixed genuine LAME bytes, not subprocesses or writes in the mutation test closure.
// Regeneration, decoding and independent span/Info oracles run in a separate CI lane.
const manifest = JSON.parse(
  await readFile(new URL('../fixtures/lame-free-format.json', import.meta.url), 'utf8'),
) as { schemaVersion: number; encoder: string; records: EncoderFixture[] };
expect(manifest.schemaVersion).toBe(1);
expect(manifest.encoder).toBe('LAME 3.100');
expect(manifest.records.map((record) => record.name)).toEqual([
  '44100-1-400-false',
  '48000-2-320-false',
  '32000-1-400-true',
  '48000-2-128-false',
  '32000-2-192-false',
]);

function verifiedBytes(record: EncoderFixture): Buffer {
  const bytes = Buffer.from(record.base64, 'base64');
  expect(bytes.length).toBe(record.bytes);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
  expect(record.physicalFrames).toBe(record.audioFrames + 1);
  return bytes;
}

it.each(manifest.records.filter((record) => record.bitrate <= 320))(
  'counts fixed genuine LAME free-format $name',
  async (record) => {
    const bytes = verifiedBytes(record);
    for (const sizes of [[3, 47, 8192], [1]]) {
      expect(await countMp3Frames(chunks(bytes, sizes))).toBe(record.physicalFrames);
      expect(await countMp3Frames(chunks(bytes, sizes), { includeVbrHeaderFrame: false })).toBe(
        record.audioFrames,
      );
    }
  },
);

// LAME can encode/decode its extensions; that does not make their rates part
// of the MPEG-1 Layer III candidate envelope used by this parser.
it.each(manifest.records.filter((record) => record.bitrate > 320))(
  'rejects fixed genuine LAME extension $name',
  async (record) => {
    const bytes = verifiedBytes(record);
    for (const sizes of [[3, 47, 8192], [1]]) {
      for (const includeVbrHeaderFrame of [true, false]) {
        await expect(
          countMp3Frames(chunks(bytes, sizes), { includeVbrHeaderFrame }),
        ).rejects.toMatchObject({ kind: 'unsupported-format' });
      }
    }
  },
);
