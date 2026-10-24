import { describe, expect, it } from 'vitest';
import { parseFrameHeader, looksLikeUnsupportedMpeg } from '../src/mp3/frame-header.js';
import { frame } from './helpers/mp3-fixtures.js';

describe('MPEG-1 Layer III headers', () => {
  it('decodes 128kbps/44100Hz unpadded header', () => {
    expect(parseFrameHeader(frame())).toEqual({
      length: 417,
      bitrateKbps: 128,
      sampleRateHz: 44_100,
      padding: 0,
      hasCrc: false,
    });
  });

  it('reads CRC and padding without changing the audio format', () => {
    expect(parseFrameHeader(frame({ padding: 1, hasCrc: true }))).toEqual({
      length: 418,
      bitrateKbps: 128,
      sampleRateHz: 44_100,
      padding: 1,
      hasCrc: true,
    });
  });

  it.each([
    [1, 0, 104],
    [14, 2, 1440],
    [9, 1, 384],
  ])('uses bitrate index %i and rate index %i', (bitrateIndex, sampleRateIndex, expectedLength) => {
    const parsed = parseFrameHeader(frame({ bitrateIndex, sampleRateIndex }));
    expect(parsed?.length).toBe(expectedLength);
  });

  it('rejects reserved rate, free/invalid bitrate, short and non-sync headers', () => {
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0]))).toBeNull();
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0x9c, 0]))).toBeNull();
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0x00, 0]))).toBeNull();
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0x90]))).toBeNull();
    expect(parseFrameHeader(Buffer.alloc(4))).toBeNull();
  });

  it('rejects MPEG-2, layer II, and reserved emphasis', () => {
    const mpeg2 = frame();
    mpeg2[1] = 0xf3;
    expect(looksLikeUnsupportedMpeg(mpeg2)).toBe(true);
    expect(parseFrameHeader(mpeg2)).toBeNull();
    const layerII = frame();
    layerII[1] = 0xfd;
    expect(looksLikeUnsupportedMpeg(layerII)).toBe(true);
    expect(parseFrameHeader(layerII)).toBeNull();
    const emphasis = frame();
    emphasis[3] = 0x02;
    expect(parseFrameHeader(emphasis)).toBeNull();
  });
  it('rejects short or ordinary invalid MPEG-like headers before detecting unsupported formats', () => {
    expect(looksLikeUnsupportedMpeg(Buffer.from([0xff, 0xfb, 0x90]))).toBe(false);
    expect(looksLikeUnsupportedMpeg(Buffer.from([0, 0xf3, 0x90, 0]))).toBe(false);
    expect(looksLikeUnsupportedMpeg(frame())).toBe(false);
  });

  it('decodes every defined MPEG-1 Layer III bitrate, rate, padding and CRC combination', () => {
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const rates = [44_100, 48_000, 32_000];
    for (let bitrateIndex = 1; bitrateIndex <= 14; bitrateIndex++) {
      for (let sampleRateIndex = 0; sampleRateIndex < 3; sampleRateIndex++) {
        for (const padding of [0, 1] as const) {
          for (const hasCrc of [true, false]) {
            const result = parseFrameHeader(
              frame({ bitrateIndex, sampleRateIndex, padding, hasCrc }),
            );
            expect(result).toEqual({
              length:
                Math.floor((144_000 * bitrates[bitrateIndex]!) / rates[sampleRateIndex]!) + padding,
              bitrateKbps: bitrates[bitrateIndex],
              sampleRateHz: rates[sampleRateIndex],
              padding,
              hasCrc,
            });
          }
        }
      }
    }
  });
});
