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
