import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './release-utils.mjs';

const destination = new URL('../tests/fixtures/lame-free-format.json', import.meta.url);
const configurations = [
  { rate: 44_100, channels: 1, bitrate: 400, crc: false },
  { rate: 48_000, channels: 2, bitrate: 320, crc: false },
  { rate: 32_000, channels: 1, bitrate: 400, crc: true },
  { rate: 48_000, channels: 2, bitrate: 128, crc: false },
  { rate: 32_000, channels: 2, bitrate: 192, crc: false },
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function requireEncoder(binary = 'lame') {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, 'LAME 3.100 is required; this lane must not skip');
  assert.match(result.stdout, /version 3\.100(?:\s|$)/, 'Reviewed LAME version changed');
  return binary;
}

export function pcmWave(rate, channels) {
  const samples = rate / 2;
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

// Independent oracle: known encoder bitrate/rate sets spans; Info declares audio frames.
// No production parser, source imports, or decoded-frame/physical-frame conflation.
export function inspectEncoded(bytes, { rate, channels, bitrate, crc }) {
  const position = channels === 1 ? 21 : 36;
  const offsets = crc ? [position + 2, position] : [position];
  const info = offsets.find((offset) => bytes.toString('ascii', offset, offset + 4) === 'Info');
  assert.notEqual(info, undefined, 'Expected LAME Info metadata');
  const audioFrames = bytes.readUInt32BE(info + 8);
  assert.ok(audioFrames > 2 && audioFrames < 100, 'Unexpected encoder count');
  let offset = 0;
  let physicalFrames = 0;
  const base = Math.floor((144_000 * bitrate) / rate);
  while (offset < bytes.length) {
    assert.equal(bytes[offset], 255);
    assert.equal(bytes[offset + 1] & 0xfe, 0xfa);
    assert.equal(bytes[offset + 2] >>> 4, 0, 'Not a free-format frame');
    offset += base + ((bytes[offset + 2] >>> 1) & 1);
    physicalFrames++;
  }
  assert.equal(offset, bytes.length, 'Truncated encoder output');
  assert.equal(physicalFrames, audioFrames + 1, 'Metadata and independent span oracle disagree');
  return { audioFrames, physicalFrames };
}

function runEncoder(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

async function generateOne(binary, directory, configuration) {
  const { rate, channels, bitrate, crc } = configuration;
  const name = `${rate}-${channels}-${bitrate}-${crc}`;
  const wave = pcmWave(rate, channels);
  const wav = join(directory, `${name}.wav`);
  const mp3 = join(directory, `${name}.mp3`);
  const decoded = join(directory, `${name}-decoded.wav`);
  await writeFile(wav, wave);
  const args = ['--silent', '--freeformat', '-b', String(bitrate), ...(crc ? ['-p'] : [])];
  runEncoder(binary, [...args, wav, mp3]);
  runEncoder(binary, ['--silent', '--decode', mp3, decoded]);
  assert.ok((await readFile(decoded)).length > 44, 'LAME could not decode its genuine audio');
  const bytes = await readFile(mp3);
  return {
    name,
    ...configuration,
    arguments: args,
    pcmSha256: digest(wave),
    sha256: digest(bytes),
    bytes: bytes.length,
    ...inspectEncoded(bytes, configuration),
    base64: bytes.toString('base64'),
  };
}

export async function verifyEncoderFixtures({ binary = 'lame', write = false } = {}) {
  requireEncoder(binary);
  const directory = await mkdtemp(join(tmpdir(), 'mp3-encoder-provenance-'));
  try {
    const records = [];
    for (const configuration of configurations) {
      records.push(await generateOne(binary, directory, configuration));
    }
    const manifest = {
      schemaVersion: 1,
      encoder: 'LAME 3.100',
      signal: '440Hz sine, 0.5s, 16-bit PCM',
      records,
    };
    if (write) await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
    else
      assert.deepEqual(
        manifest,
        JSON.parse(await readFile(destination, 'utf8')),
        'Encoder fixture drift',
      );
    console.log(
      `Verified ${records.length} genuine encoder fixtures, independent counts, and decoded audio`,
    );
    return manifest;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  assert.ok(process.argv.slice(2).every((argument) => argument === '--write'));
  await verifyEncoderFixtures({
    binary: process.env.LAME_BINARY ?? 'lame',
    write: process.argv.includes('--write'),
  });
}
