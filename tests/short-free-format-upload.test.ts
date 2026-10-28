import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { multipartBody } from './helpers/mp3-fixtures.js';

it('counts an EOF-closed singleton with a dead-end ancillary header in both upload modes', async () => {
  const bytes = Buffer.alloc(864);
  bytes.set([255, 251, 4, 192]);
  bytes.set([255, 251, 4, 192], 100);
  const app = await buildApp();
  try {
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
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ frameCount: 1 });
      }
    }
  } finally {
    await app.close();
  }
});
