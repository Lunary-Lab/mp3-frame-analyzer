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
    expect(wrongField.json()).toHaveProperty('error', 'invalid-upload');
  });

  it('rejects unsupported MIME and corrupt audio contents', async () => {
    const wrongMime = await upload(frame(), { mime: 'text/plain' });
    expect(wrongMime.statusCode).toBe(415);
    expect(wrongMime.json()).toHaveProperty('error', 'unsupported-media-type');
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

  it('rejects valid JSON requests that do not contain multipart data', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': 'application/json' },
      payload: { frameCount: 17 },
    });
    expect(response.statusCode).toBe(415);
  });

  it('classifies a missing multipart boundary as a client error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': 'multipart/form-data' },
      payload: 'incomplete form',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      error: 'invalid-upload',
      message: 'Invalid or incomplete multipart request',
    });
  });

  it.each(['audio/mpeg', 'audio/mp3', 'application/octet-stream'])(
    'accepts the documented %s MIME type',
    async (mime) => {
      const response = await upload(frame(), { mime });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ frameCount: 1 });
    },
  );

  it('keeps unexpected failures as sanitized HTTP 500 responses', async () => {
    const failingApp = await buildApp();
    // A failed request hook is a real framework boundary, independent of parser details.
    failingApp.addHook('preHandler', async () => {
      throw new Error('Internal diagnostic detail must remain private');
    });
    try {
      const { payload, contentType } = multipartBody(frame());
      const response = await failingApp.inject({
        method: 'POST',
        url: '/file-upload',
        headers: { 'content-type': contentType },
        payload,
      });
      expect(response.statusCode).toBe(500);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({
        error: 'internal-error',
        message: 'Unable to process upload',
      });
    } finally {
      await failingApp.close();
    }
  });

  it('returns 404 for unrelated routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/unknown' })).statusCode).toBe(404);
  });
});
