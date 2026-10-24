import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks } from './helpers/mp3-fixtures.js';

/** Self-contained PCM sine fixture: production code never invokes an encoder. */
function pcmWave(rate: number, channels: number): Buffer {
  // Half a second yields enough frames for multiples of a constant span to align.
  const samples = Math.floor(rate / 2);
  const dataBytes = samples * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(dataBytes + 36, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let sample = 0; sample < samples; sample++) {
    const value = Math.round(14_000 * Math.sin((2 * Math.PI * 440 * sample) / rate));
    for (let channel = 0; channel < channels; channel++) {
      wav.writeInt16LE(value, 44 + (sample * channels + channel) * 2);
    }
  }
  return wav;
}

const available = spawnSync('lame', ['--version'], { stdio: 'ignore' }).status === 0;

it.skipIf(!available)(
  'counts genuine LAME free-format streams including 400 kbps, CRC, and differing rates',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mp3-free-format-'));
    try {
      const configurations = [
        { rate: 44_100, channels: 1, bitrate: 400, crc: false },
        { rate: 48_000, channels: 2, bitrate: 320, crc: false },
        { rate: 32_000, channels: 1, bitrate: 400, crc: true },
        // Constant spans without padding variation, where multiples also align.
        { rate: 48_000, channels: 2, bitrate: 128, crc: false },
        { rate: 32_000, channels: 2, bitrate: 192, crc: false },
      ];
      for (const { rate, channels, bitrate, crc } of configurations) {
        const name = `${rate}-${channels}-${bitrate}-${crc}`;
        const wav = join(directory, name + '.wav');
        const mp3 = join(directory, name + '.mp3');
        const decoded = join(directory, name + '-decoded.wav');
        await writeFile(wav, pcmWave(rate, channels));
        const run = (args: string[]) => {
          const result = spawnSync('lame', args, { encoding: 'utf8', timeout: 10_000 });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
        };
        run(['--silent', '--freeformat', '-b', String(bitrate), ...(crc ? ['-p'] : []), wav, mp3]);
        run(['--silent', '--decode', mp3, decoded]);

        const encoded = await readFile(mp3);
        const decodedBytes = await readFile(decoded);
        expect(decodedBytes.length).toBeGreaterThan(44);
        expect(encoded[0]).toBe(0xff);
        expect(encoded[1]! & 0xfe).toBe(0xfa);
        expect(encoded[2]! >>> 4).toBe(0); // LAME's free-format bitrate index

        const physical = await countMp3Frames(chunks(encoded, [3, 47, 8192]));
        expect(physical).toBeGreaterThanOrEqual(3);

        // The LAME-generated Info frame has a declared *audio* frame count.
        // Unlike the parser under test, this independent oracle reads encoder
        // metadata; the production implementation must traverse every frame.
        const pos = channels === 1 ? 21 : 36;
        const locations = crc ? [pos + 2, pos] : [pos];
        const offset = locations.find(
          (location) => encoded.toString('ascii', location, location + 4) === 'Info',
        );
        expect(offset).toBeDefined();
        const declaredAudio = encoded.readUInt32BE(offset! + 8);
        expect(physical).toBe(declaredAudio + 1);
        expect(await countMp3Frames(chunks(encoded, [1]), { includeVbrHeaderFrame: false })).toBe(
          declaredAudio,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
