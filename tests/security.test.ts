import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MAX_UPLOAD_BYTES } from '../src/upload.js';
import { frame, mp3, multipartBody, synchsafe } from './helpers/mp3-fixtures.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

it('rejects a multipart file larger than the configured limit with HTTP 413', async () => {
  // Exercise the exact same Fastify limit and parser-error interaction without
  // allocating 50+ MiB in the test process or relying on timeout-sensitive CI.
  const limitedApp = await buildApp({ maxUploadBytes: 256 });
  try {
    const tag = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from([4, 0, 0]),
      synchsafe(1_024),
      Buffer.alloc(300),
    ]);
    const { contentType, payload } = multipartBody(tag);
    const result = await limitedApp.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': contentType },
      payload,
    });
    expect(result.statusCode).toBe(413);
    expect(result.json()).toHaveProperty('error', 'file-too-large');
  } finally {
    await limitedApp.close();
  }
});

it('rejects invalid upload limits rather than running with an unbounded buffer', async () => {
  await expect(buildApp({ maxUploadBytes: 0 })).rejects.toThrow(RangeError);
  expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
});

it.each([
  { description: 'accepts exactly the file-size limit', limit: 417, extra: 0, status: 200 },
  { description: 'rejects a limit inside the final frame', limit: 416, extra: 0, status: 413 },
  {
    description: 'rejects one byte after a complete frame at the limit',
    limit: 417,
    extra: 1,
    status: 413,
  },
])('$description', async ({ limit, extra, status }) => {
  const limitedApp = await buildApp({ maxUploadBytes: limit });
  try {
    const bytes = Buffer.concat([frame(), Buffer.alloc(extra)]);
    const { contentType, payload } = multipartBody(bytes);
    const response = await limitedApp.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': contentType },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('application/json');
    if (status === 200) {
      expect(response.json()).toEqual({ frameCount: 1 });
    } else {
      expect(response.json()).toHaveProperty('error', 'file-too-large');
    }
  } finally {
    await limitedApp.close();
  }
});

it('rejects text fields without accepting an empty file upload', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'multipart/form-data; boundary=field-test' },
    payload:
      '--field-test\r\nContent-Disposition: form-data; name="description"\r\n\r\nexample\r\n--field-test--\r\n',
  });
  expect(response.statusCode).toBe(413);
  expect(response.json()).toHaveProperty('error', 'unexpected-fields');
});

it('does not parse file declarations beyond the bounded multipart header buffer', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'multipart/form-data; boundary=header-test' },
    payload: Buffer.concat([
      Buffer.from(
        `--header-test\r\nX-Description: ${'a'.repeat(8 * 1024)}\r\nContent-Disposition: form-data; name="file"; filename="sample.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
      frame(),
      Buffer.from('\r\n--header-test--\r\n'),
    ]),
  });
  // Busboy bounds parsing/buffering by truncation, not a dedicated HTTP 413.
  expect(response.statusCode).toBe(400);
  expect(response.json()).toHaveProperty('error', 'missing-file');
});

it.each(['file', 'field'] as const)(
  'rejects an additional %s part after a valid file',
  async (kind) => {
    const first = multipartBody(frame());
    const boundary = first.contentType.split('boundary=')[1]!;
    const closing = Buffer.from(`--${boundary}--\r\n`);
    const extra =
      kind === 'file'
        ? Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="second.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
            ),
            frame(),
            Buffer.from('\r\n'),
          ])
        : Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nexample\r\n`,
          );
    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': first.contentType },
      payload: Buffer.concat([first.payload.subarray(0, -closing.length), extra, closing]),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toHaveProperty('error', 'too-many-parts');
  },
);

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

it('rejects a reserved bitrate index at a required frame boundary', async () => {
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

const cutOffForms = {
  'inside the upload bytes': (payload: Buffer) =>
    payload.subarray(0, payload.indexOf('\r\n\r\n') + 50),
  'after the upload bytes': (payload: Buffer) => payload.subarray(0, payload.lastIndexOf('\r\n--')),
};

it.each([
  ...Object.entries(cutOffForms).flatMap(([cut, shorten]) => [
    [`valid audio cut off ${cut}`, multipartBody(mp3([frame(), frame()])), shorten] as const,
    [`invalid audio cut off ${cut}`, multipartBody(Buffer.alloc(4096)), shorten] as const,
  ]),
  [
    'a rejected field cut off inside its bytes',
    multipartBody(frame(), { field: 'other' }),
    cutOffForms['inside the upload bytes'],
  ] as const,
])('rejects %s with 400 however the body arrives', async (_, { contentType, payload }, shorten) => {
  // Injection delivers the whole cut-off body to Busboy in one burst.
  const response = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': contentType },
    payload: shorten(payload),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
    error: 'invalid-upload',
    message: 'Invalid or incomplete multipart request',
  });
});

it('rejects malformed multipart termination gracefully', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'multipart/form-data; boundary=bad' },
    payload:
      '--bad\r\nContent-Disposition: form-data; name="file"; filename="x.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toHaveProperty('error', 'invalid-upload');
  expect(response.headers['content-type']).toContain('application/json');
});
