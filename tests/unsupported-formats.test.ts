import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { chunks, multipartBody } from './helpers/mp3-fixtures.js';
import { invalidHeader, unsupportedHeader } from './helpers/format-classification-fixtures.js';

interface Fixture {
  label: string;
  mediaType: string;
  mpeg: boolean;
  sha256: string;
  base64: string;
}
const corpus = JSON.parse(
  await readFile(new URL('./fixtures/unsupported-formats.json', import.meta.url), 'utf8'),
) as {
  fixtures: Fixture[];
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

describe('independently encoded out-of-scope audio', () => {
  it.each(corpus.fixtures)(
    '$label retains its distinct scope or media-type error',
    async (fixture) => {
      const bytes = Buffer.from(fixture.base64, 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      for (const sizes of [[1], [2, 3, 7], [4096]]) {
        await expect(countMp3Frames(chunks(bytes, sizes))).rejects.toMatchObject({
          kind: fixture.mpeg ? 'unsupported-format' : 'invalid-mp3',
          offset: 0,
          message: fixture.mpeg ? unsupportedHeader : invalidHeader,
        });
      }
      // A declared unsupported media type is different from mislabeled non-MPEG bytes.
      for (const mime of new Set([fixture.mediaType, 'audio/mpeg', 'application/octet-stream'])) {
        const declared = mime === 'audio/aac' || mime === 'audio/mp4';
        const forms = [{ contentType: mime, payload: bytes }, multipartBody(bytes, { mime })];
        for (const [index, { contentType, payload }] of forms.entries()) {
          const response = await app.inject({
            method: 'POST',
            url: '/file-upload',
            headers: { 'content-type': contentType },
            payload,
          });
          expect(response.statusCode).toBe(declared || fixture.mpeg ? 415 : 422);
          expect(response.headers['content-type']).toContain('application/json');
          expect(response.json()).toEqual(
            declared
              ? {
                  error: 'unsupported-media-type',
                  message: index === 0 ? 'Expected an MP3 upload' : 'Expected an MP3 file',
                }
              : {
                  error: fixture.mpeg ? 'unsupported-format' : 'invalid-mp3',
                  message: fixture.mpeg ? unsupportedHeader : invalidHeader,
                },
          );
        }
      }
    },
  );
});
