import { describe, expect, it } from 'vitest';
import { decodeFrameHeader } from '../src/mp3/frame-header.js';
import { frame } from './helpers/mp3-fixtures.js';

const kindOf = (bytes: readonly number[]) => decodeFrameHeader(Uint8Array.from(bytes)).kind;

describe('MPEG-1 Layer III headers', () => {
  it('decodes a 128 kbps / 44.1 kHz unpadded stereo header', () => {
    expect(decodeFrameHeader(frame())).toEqual({
      kind: 'indexed',
      length: 417,
      sampleRateIndex: 0,
      padding: 0,
      hasCrc: false,
      mono: false,
    });
  });

  it('reads CRC, padding and channel mode without changing the audio format', () => {
    const mono = frame({ padding: 1, hasCrc: true });
    mono[3] = mono[3]! | 0xc0;
    expect(decodeFrameHeader(mono)).toEqual({
      kind: 'indexed',
      length: 418,
      sampleRateIndex: 0,
      padding: 1,
      hasCrc: true,
      mono: true,
    });
  });

  it.each([
    [1, 0, 104],
    [14, 2, 1440],
    [9, 1, 384],
  ])('uses bitrate index %i and rate index %i', (bitrateIndex, sampleRateIndex, expectedLength) => {
    expect(decodeFrameHeader(frame({ bitrateIndex, sampleRateIndex }))).toMatchObject({
      kind: 'indexed',
      length: expectedLength,
      sampleRateIndex,
    });
  });

  it('decodes every defined MPEG-1 Layer III bitrate, rate, padding and CRC combination', () => {
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const rates = [44_100, 48_000, 32_000];
    for (let bitrateIndex = 1; bitrateIndex <= 14; bitrateIndex++) {
      for (let sampleRateIndex = 0; sampleRateIndex < 3; sampleRateIndex++) {
        for (const padding of [0, 1] as const) {
          for (const hasCrc of [true, false]) {
            expect(
              decodeFrameHeader(frame({ bitrateIndex, sampleRateIndex, padding, hasCrc })),
            ).toEqual({
              kind: 'indexed',
              length:
                Math.floor((144_000 * bitrates[bitrateIndex]!) / rates[sampleRateIndex]!) + padding,
              sampleRateIndex,
              padding,
              hasCrc,
              mono: false,
            });
          }
        }
      }
    }
  });

  it('decodes the free-format subtype with its padding, rate and CRC', () => {
    for (const protection of [0xfa, 0xfb]) {
      for (const [rateAndPadding, sampleRateIndex, padding] of [
        [0x00, 0, 0],
        [0x04, 1, 0],
        [0x08, 2, 0],
        [0x02, 0, 1],
      ] as const) {
        expect(decodeFrameHeader(Uint8Array.of(0xff, protection, rateAndPadding, 0xc0))).toEqual({
          kind: 'free-format',
          sampleRateIndex,
          padding,
          hasCrc: protection === 0xfa,
          mono: true,
        });
      }
    }
  });

  it('rejects reserved rate, reserved bitrate and reserved emphasis as invalid', () => {
    expect(kindOf([0xff, 0xfb, 0xf0, 0])).toBe('invalid');
    expect(kindOf([0xff, 0xfb, 0x9c, 0])).toBe('invalid');
    expect(kindOf([0xff, 0xfb, 0x0c, 0])).toBe('invalid');
    expect(kindOf([0xff, 0xfb, 0x90, 0x02])).toBe('invalid');
    expect(kindOf([0xff, 0xfb, 0x00, 0x02])).toBe('invalid');
  });

  it('requires all eleven sync bits before classifying anything as MPEG', () => {
    expect(kindOf([0, 0, 0, 0])).toBe('invalid');
    expect(kindOf([0x7f, 0xfb, 0x90, 0])).toBe('invalid');
    expect(kindOf([0, 0xf3, 0x90, 0])).toBe('invalid');
    expect(kindOf([0xff, 0x00, 0x90, 0])).toBe('invalid');
    expect(kindOf([0xff, 0xdb, 0x90, 0])).toBe('invalid');
  });

  it('classifies other MPEG versions and layers as unsupported', () => {
    expect(kindOf([0xff, 0xf3, 0x90, 0])).toBe('unsupported'); // MPEG-2 Layer III
    expect(kindOf([0xff, 0xe3, 0x90, 0])).toBe('unsupported'); // MPEG-2.5 Layer III
    expect(kindOf([0xff, 0xeb, 0x90, 0])).toBe('unsupported'); // reserved version
    expect(kindOf([0xff, 0xfd, 0x90, 0])).toBe('unsupported'); // MPEG-1 Layer II
    expect(kindOf([0xff, 0xff, 0x90, 0])).toBe('unsupported'); // MPEG-1 Layer I
    expect(kindOf([0xff, 0xf9, 0x90, 0])).toBe('unsupported'); // reserved layer
  });
});
