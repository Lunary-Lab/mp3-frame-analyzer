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

  it('returns an explicit JSON 405 with Allow: POST for wrong upload methods', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const response = await app.inject({ method, url: '/file-upload?unused=true' });
      expect(response.statusCode).toBe(405);
      expect(response.headers['allow']).toBe('POST');
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({
        error: 'method-not-allowed',
        message: 'Use POST /file-upload',
      });
    }
  });

  it('rejects HEAD /file-upload with Allow: POST', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/file-upload' });
    expect(response.statusCode).toBe(405);
    expect(response.headers['allow']).toBe('POST');
  });

  it('returns a sanitized JSON 404 for unrelated routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/unknown' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'not-found', message: 'Route not found' });
  });

  it('rejects an empty multipart file as 400, distinct from malformed audio', async () => {
    const empty = await upload(Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({
      error: 'empty-file',
      message: 'The MP3 file must not be empty',
    });

    const invalid = await upload(Buffer.from('not an MP3'));
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toHaveProperty('error', 'invalid-mp3');
  });

  it.each([
    ['image/png', 'binary'],
    ['application/pdf', 'binary'],
    ['application/json', '{"not":"an upload"}'],
    ['application/json', '{invalid-json'],
  ])(
    'reports unsupported %s bodies with a 415, even before route handling',
    async (mime, payload) => {
      const response = await app.inject({
        method: 'POST',
        url: '/file-upload',
        headers: { 'content-type': mime },
        payload,
      });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toEqual({
        error: 'unsupported-media-type',
        message: 'Expected an MP3 upload',
      });
    },
  );

  it('sanitizes unknown Fastify-style HTTP 413 errors instead of claiming file size', async () => {
    const failingApp = await buildApp();
    failingApp.addHook('preHandler', async () => {
      throw Object.assign(new Error('internal resource detail'), { statusCode: 413 });
    });
    try {
      const { contentType, payload } = multipartBody(frame());
      const response = await failingApp.inject({
        method: 'POST',
        url: '/file-upload',
        headers: { 'content-type': contentType },
        payload,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({
        error: 'request-too-large',
        message: 'Request exceeds configured limits',
      });
    } finally {
      await failingApp.close();
    }
  });
});
