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

  it('closes the connection after rejecting an invalid option, before reading the upload', async () => {
    const form = multipartBody(frame());
    for (const [contentType, payload] of [
      ['audio/mpeg', frame()],
      [form.contentType, form.payload],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/file-upload?includeVbrHeaderFrame=maybe',
        headers: { 'content-type': contentType },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toHaveProperty('error', 'invalid-option');
      expect(response.headers.connection).toBe('close');
    }
  });

  it.each(['audio/mpeg', 'audio/mp3', 'application/octet-stream'])(
    'accepts a %s file part without the optional filename',
    async (mime) => {
      const form = multipartBody(frame(), { mime });
      const payload = Buffer.from(
        form.payload.toString('latin1').replace('; filename="test.mp3"', ''),
        'latin1',
      );
      const response = await app.inject({
        method: 'POST',
        url: '/file-upload',
        headers: { 'content-type': form.contentType },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ frameCount: 1 });
    },
  );

  it.each(
    ['audio/mpeg', 'audio/mp3', 'application/octet-stream'].flatMap((mime) => [
      ` ${mime}`,
      `${mime} `,
      `\t${mime}`,
      `${mime}\t`,
    ]),
  )('accepts outer SP/HTAB around the multipart media type %j', async (mime) => {
    const form = multipartBody(frame(), { mime });
    for (const filename of [true, false]) {
      const payload = filename
        ? form.payload
        : Buffer.from(
            form.payload.toString('latin1').replace('; filename="test.mp3"', ''),
            'latin1',
          );
      const response = await app.inject({
        method: 'POST',
        url: '/file-upload',
        headers: { 'content-type': form.contentType },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ frameCount: 1 });
    }
  });

  it.each(['audio/mp eg', 'audio/mp\teg', ' audio/wav ', '"audio/mpeg;"'])(
    'does not normalize disallowed multipart media type %j into an allowed one',
    async (mime) => {
      const response = await upload(frame(), { mime });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toHaveProperty('error', 'unsupported-media-type');
    },
  );

  it('accepts a mixed-case media type with parameters, raw or multipart', async () => {
    const mime = 'Audio/MPEG ; x=1';
    const raw = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': mime },
      payload: frame(),
    });
    for (const response of [raw, await upload(frame(), { mime })]) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ frameCount: 1 });
    }
  });

  it('treats a no-break space around the media type as part of it, raw or multipart', async () => {
    // HTTP's optional whitespace is SP or HTAB only (RFC 9110 §5.6.3). Send a
    // single 0xA0 byte, as a client would, not its two-byte UTF-8 encoding.
    const form = multipartBody(frame(), { mime: 'NBSP-MEDIA-TYPE' });
    const payload = Buffer.from(
      form.payload.toString('latin1').replace('NBSP-MEDIA-TYPE', '\u00a0audio/mpeg\u00a0'),
      'latin1',
    );
    const multipart = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': form.contentType },
      payload,
    });
    const raw = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': '\u00a0audio/mpeg\u00a0' },
      payload: frame(),
    });
    for (const response of [multipart, raw]) {
      expect(response.statusCode).toBe(415);
      expect(response.json()).toHaveProperty('error', 'unsupported-media-type');
    }
    // The raw body is unread, so its connection must not be reused.
    expect(raw.headers.connection).toBe('close');
  });

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
});
