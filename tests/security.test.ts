import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, MAX_UPLOAD_BYTES } from '../src/app.js';
import { frame, id3v2, multipartBody, synchsafe } from './helpers/mp3-fixtures.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

it('rejects a multipart file larger than the configured 50 MiB limit', async () => {
  // A large ID3 tag forces the parser to consume the upload rather than
  // short-circuiting early on malformed audio.
  const tag = Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([4, 0, 0]),
    synchsafe(MAX_UPLOAD_BYTES),
    Buffer.alloc(MAX_UPLOAD_BYTES + 1),
  ]);
  const { contentType, payload } = multipartBody(tag);
  const result = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': contentType },
    payload,
  });
  expect(result.statusCode).toBe(413);
  expect(result.json()).toHaveProperty('error', 'file-too-large');
});

it('does not trust the file extension or the client-provided MIME alone', async () => {
  const fake = multipartBody(Buffer.from('arbitrary bytes'), { filename: 'trusted.mp3' });
  const result = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': fake.contentType },
    payload: fake.payload,
  });
  expect(result.statusCode).toBe(422);
});

it('rejects frame data with an enormous fake frame offset without allocating it', async () => {
  const malformed = Buffer.concat([frame(), Buffer.from([0xff, 0xfb, 0xf0, 0x00])]);
  const { payload, contentType } = multipartBody(malformed);
  const result = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': contentType },
    payload,
  });
  expect(result.statusCode).toBe(422);
});

it('rejects malformed multipart termination gracefully', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'multipart/form-data; boundary=bad' },
    payload: '--bad\r\nContent-Disposition: form-data; name="file"; filename="x.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n',
  });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect(response.statusCode).toBeLessThan(500);
  expect(response.headers['content-type']).toContain('application/json');
});
