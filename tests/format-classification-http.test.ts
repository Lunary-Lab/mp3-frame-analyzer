import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { frame, id3v2, multipartBody } from './helpers/mp3-fixtures.js';
import {
  headerCases,
  indexedVariants,
  tagCases,
  tagVersion,
} from './helpers/format-classification-fixtures.js';

let app: FastifyInstance;
let endpoint: string;
beforeAll(async () => {
  app = await buildApp();
  endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
});

async function responses(bytes: Buffer, query = '', mime = 'audio/mpeg') {
  return Promise.all(
    [{ contentType: mime, payload: bytes }, multipartBody(bytes, { mime })].map(
      ({ contentType, payload }) =>
        app.inject({
          method: 'POST',
          url: '/file-upload' + query,
          headers: { 'content-type': contentType },
          payload,
        }),
    ),
  );
}

async function expectError(bytes: Buffer, status: number, error: string, message: string) {
  for (const response of await responses(bytes)) {
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error, message });
  }
}

/** Real HTTP chunked transfer; parser partition invariance is tested independently. */
function sendChunked(payload: Buffer, contentType: string, width: number) {
  return new Promise<{ status: number | undefined; mime: string | undefined; body: unknown }>(
    (resolve, reject) => {
      const request = httpRequest(
        endpoint + '/file-upload',
        {
          method: 'POST',
          headers: { 'content-type': contentType },
        },
        (response) => {
          const parts: Buffer[] = [];
          response.on('data', (part: Buffer) => parts.push(part));
          response.once('error', reject);
          response.once('end', () => {
            try {
              resolve({
                status: response.statusCode,
                mime: response.headers['content-type'],
                body: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown,
              });
            } catch (error) {
              reject(new Error('Invalid JSON response', { cause: error }));
            }
          });
        },
      );
      request.once('error', reject);
      for (let at = 0; at < payload.length; at += width)
        request.write(payload.subarray(at, at + width));
      request.end();
    },
  );
}

describe('raw and multipart format error contract', () => {
  it.each([...headerCases, ...tagCases])('$label returns the exact public error', async (test) => {
    for (const prefix of [Buffer.alloc(0), frame()]) {
      await expectError(
        Buffer.concat([prefix, test.bytes]),
        test.kind === 'unsupported-format' ? 415 : 422,
        test.kind,
        test.message,
      );
    }
  });

  it.each([...headerCases, ...tagCases])(
    '$label keeps the same JSON over chunked TCP',
    async (test) => {
      for (const { contentType, payload } of [
        { contentType: 'audio/mpeg', payload: test.bytes },
        multipartBody(test.bytes),
      ]) {
        for (const width of [1, 7]) {
          const response = await sendChunked(payload, contentType, width);
          expect(response.status).toBe(test.kind === 'unsupported-format' ? 415 : 422);
          expect(response.mime).toContain('application/json');
          expect(response.body).toEqual({ error: test.kind, message: test.message });
        }
      }
    },
  );

  it('distinguishes absent input, incomplete headers, incomplete payloads and no frames', async () => {
    await expectError(Buffer.alloc(0), 400, 'empty-file', 'The MP3 file must not be empty');
    for (let length = 1; length <= 3; length++) {
      const partial = frame().subarray(0, length);
      await expectError(partial, 422, 'invalid-mp3', 'No MPEG-1 Layer III frames found');
      await expectError(
        Buffer.concat([frame(), partial]),
        422,
        'truncated-mp3',
        'Incomplete trailing frame header',
      );
    }
    await expectError(
      Buffer.concat([frame(), Buffer.from('ID3')]),
      422,
      'truncated-mp3',
      'Incomplete trailing frame header',
    );
    await expectError(frame().subarray(0, -1), 422, 'truncated-mp3', 'Unexpected end of MP3');
    await expectError(
      id3v2(Buffer.alloc(7)),
      422,
      'invalid-mp3',
      'No MPEG-1 Layer III frames found',
    );
    for (const version of [4, 5, 255]) {
      await expectError(
        tagVersion(version, 255).subarray(0, 9),
        422,
        'truncated-mp3',
        'Incomplete ID3v2 tag header',
      );
    }
  });

  it('preserves ID3 size and footer validation separately from scope rejection', async () => {
    const size = id3v2(Buffer.alloc(0));
    size[6] = 0x80;
    await expectError(size, 422, 'invalid-mp3', 'Invalid synchsafe ID3v2 size');
    const flags = id3v2(Buffer.alloc(0));
    flags[5] = 1;
    await expectError(flags, 422, 'invalid-mp3', 'Reserved ID3v2 flags are set');
    const tag = id3v2(Buffer.alloc(1), 4, true);
    await expectError(tag.subarray(0, -1), 422, 'truncated-mp3', 'Incomplete ID3v2 footer');
    tag[tag.length - 1] = 2;
    await expectError(tag, 422, 'invalid-mp3', 'Invalid ID3v2 footer');
  });

  it.each([0, 1, 2])(
    'accepts all indexed geometry at rate index %i in both upload forms',
    async (rate) => {
      const bytes = Buffer.concat(indexedVariants(rate));
      for (const query of ['', '?includeVbrHeaderFrame=false', '?includeVbrHeaderFrame=true']) {
        for (const response of await responses(bytes, query)) {
          expect(response.statusCode).toBe(200);
          expect(response.headers['content-type']).toContain('application/json');
          expect(response.json()).toEqual({ frameCount: 224 });
        }
      }
    },
  );

  it.each([2, 3, 4] as const)(
    'accepts supported ID3v2.%i envelopes in both forms',
    async (version) => {
      for (const revision of [0, 1, 254]) {
        for (const response of await responses(
          Buffer.concat([tagVersion(version, revision), frame()]),
        )) {
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ frameCount: 1 });
        }
      }
    },
  );
});
