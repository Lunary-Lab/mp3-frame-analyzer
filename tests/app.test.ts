import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { frame, mp3, multipartBody } from './helpers/mp3-fixtures.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

const upload = async (bytes: Uint8Array, options?: { field?: string; mime?: string }) => {
  const { contentType, payload } = multipartBody(bytes, options);
  return app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': contentType },
    payload,
  });
};

describe('POST /file-upload', () => {
  it('returns exactly {frameCount} with an application/json response', async () => {
    const response = await upload(mp3([frame(), frame({ padding: 1 }), frame()]));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ frameCount: 3 });
  });

  it('rejects absent multipart, missing file, and wrong field name', async () => {
    const plain = await app.inject({ method: 'POST', url: '/file-upload', payload: 'hello' });
    expect(plain.statusCode).toBe(415);
    expect(plain.json()).toHaveProperty('error');

    const empty = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': 'multipart/form-data; boundary=abc' },
      payload: '--abc--\r\n',
    });
    expect(empty.statusCode).toBe(400);

    const wrongField = await upload(frame(), { field: 'wrong' });
    expect(wrongField.statusCode).toBe(400);
  });

  it('rejects unsupported MIME and corrupt audio contents', async () => {
    const wrongMime = await upload(frame(), { mime: 'text/plain' });
    expect(wrongMime.statusCode).toBe(415);
    const corrupt = await upload(Buffer.from('not mp3'));
    expect(corrupt.statusCode).toBe(422);
    expect(corrupt.json()).toMatchObject({ error: 'invalid-mp3' });
  });

  it('rejects unsupported MPEG versions with a 415', async () => {
    const wrong = frame();
    wrong[1] = 0xf3;
    const response = await upload(wrong);
    expect(response.statusCode).toBe(415);
    expect(response.json()).toHaveProperty('error', 'unsupported-format');
  });

  it('returns 404 for unrelated routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/unknown' })).statusCode).toBe(404);
  });
});
