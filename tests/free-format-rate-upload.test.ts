import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { multipartBody } from './helpers/mp3-fixtures.js';

it('counts in-scope ancillary decoys and rejects extension-only rates through both upload modes', async () => {
  const valid = Buffer.alloc(7200);
  for (let offset = 0; offset < valid.length; offset += 900) valid.set([255, 251, 4, 192], offset);
  for (const offset of [1440, 2880]) valid.set([255, 251, 4, 192], offset);
  for (let offset = 4320; offset < valid.length; offset += 576)
    valid.set([255, 251, 0x98, 192], offset);
  const extension = Buffer.alloc(3600);
  for (let offset = 0; offset < extension.length; offset += 1200)
    extension.set([255, 251, 4, 192], offset);
  const app = await buildApp();
  try {
    for (const bytes of [valid, extension]) {
      for (const { contentType, payload } of [
        { contentType: 'audio/mpeg', payload: bytes },
        multipartBody(bytes),
      ]) {
        for (const query of ['', '?includeVbrHeaderFrame=true', '?includeVbrHeaderFrame=false']) {
          const response = await app.inject({
            method: 'POST',
            url: '/file-upload' + query,
            headers: { 'content-type': contentType },
            payload,
          });
          expect(response.headers['content-type']).toContain('application/json');
          expect(response.statusCode).toBe(bytes === valid ? 200 : 415);
          expect(response.json()).toEqual(
            bytes === valid
              ? { frameCount: 8 }
              : {
                  error: 'unsupported-format',
                  message:
                    'Cannot infer a unique free-format MPEG frame size within the supported 320 kb/s bitrate envelope',
                },
          );
        }
      }
    }
  } finally {
    await app.close();
  }
});

it.each([false, true])(
  'reports impossible upper-bound padding after locking=%s through both upload modes',
  async (locked) => {
    const bytes = Buffer.concat(
      Array.from({ length: locked ? 13 : 4 }, (_, index) => {
        const padding = !locked || index === 12;
        const frame = Buffer.alloc(960 + Number(padding));
        frame.set([255, 251, padding ? 6 : 4, 192]);
        return frame;
      }),
    );
    const app = await buildApp();
    try {
      for (const { contentType, payload } of [
        { contentType: 'audio/mpeg', payload: bytes },
        multipartBody(bytes),
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/file-upload',
          headers: { 'content-type': contentType },
          payload,
        });
        expect(response.statusCode).toBe(locked ? 422 : 415);
        expect(response.json()).toEqual({
          error: locked ? 'invalid-mp3' : 'unsupported-format',
          message: locked
            ? 'Free-format frame exceeds the supported 320 kb/s bitrate envelope'
            : 'Cannot infer a unique free-format MPEG frame size within the supported 320 kb/s bitrate envelope',
        });
      }
    } finally {
      await app.close();
    }
  },
);
