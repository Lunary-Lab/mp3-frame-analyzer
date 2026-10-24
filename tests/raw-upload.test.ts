import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { frame, mp3, multipartBody } from './helpers/mp3-fixtures.js';

let app: FastifyInstance;
let endpoint: string;
beforeAll(async () => {
  app = await buildApp();
  endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
});

function infoMp3(): Buffer {
  const initial = frame();
  initial.write('Info', 36, 'ascii');
  initial.writeUInt32BE(0x00000003, 40);
  return mp3([initial, frame(), frame()]);
}

describe('raw MPEG HTTP streaming', () => {
  it.each(['audio/mpeg', 'audio/mp3', 'application/octet-stream'])(
    'accepts %s raw MP3 and preserves JSON response',
    async (mime) => {
      const response = await fetch(endpoint + '/file-upload', {
        method: 'POST',
        headers: { 'content-type': mime },
        body: new Uint8Array(infoMp3()),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ frameCount: 3 });
    },
  );

  it('returns matching raw/multipart results with optional metadata exclusion', async () => {
    const bytes = infoMp3();
    for (const value of ['', '?includeVbrHeaderFrame=true', '?includeVbrHeaderFrame=false']) {
      const raw = await fetch(endpoint + '/file-upload' + value, {
        method: 'POST',
        headers: { 'content-type': 'audio/mpeg' },
        body: new Uint8Array(bytes),
      });
      const { contentType, payload } = multipartBody(bytes);
      const multi = await fetch(endpoint + '/file-upload' + value, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(payload),
      });
      expect(raw.status).toBe(200);
      expect(multi.status).toBe(200);
      expect(await raw.json()).toEqual(await multi.json());
    }
  });

  it.each(['maybe', '1', 'FALSE', 'true&includeVbrHeaderFrame=false'])(
    'rejects invalid option value %s with JSON 400',
    async (value) => {
      const response = await fetch(endpoint + '/file-upload?includeVbrHeaderFrame=' + value, {
        method: 'POST',
        headers: { 'content-type': 'audio/mpeg' },
        body: new Uint8Array(frame()),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error', 'invalid-option');
    },
  );

  it('enforces the file size limit on a raw upload with content length', async () => {
    const limited = await buildApp({ maxUploadBytes: 417 });
    const address = await limited.listen({ host: '127.0.0.1', port: 0 });
    try {
      const good = await fetch(address + '/file-upload', {
        method: 'POST',
        headers: { 'content-type': 'audio/mpeg' },
        body: new Uint8Array(frame()),
      });
      expect(good.status).toBe(200);
      const bad = await fetch(address + '/file-upload', {
        method: 'POST',
        headers: { 'content-type': 'audio/mpeg' },
        body: new Uint8Array(mp3([frame(), frame()])),
      });
      expect(bad.status).toBe(413);
      expect(await bad.json()).toHaveProperty('error', 'file-too-large');
    } finally {
      await limited.close();
    }
  });

  it('enforces streaming size limit on chunked raw requests without content length', async () => {
    const limited = await buildApp({ maxUploadBytes: 500 });
    const address = await limited.listen({ host: '127.0.0.1', port: 0 });
    const bytes = mp3([frame(), frame()]);
    try {
      const outcome = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          address + '/file-upload',
          {
            method: 'POST',
            headers: { 'content-type': 'audio/mpeg' },
          },
          (response) => {
            const result: Buffer[] = [];
            response.on('data', (part: Buffer) => result.push(part));
            response.once('end', () =>
              resolve({
                status: response.statusCode!,
                body: Buffer.concat(result).toString(),
              }),
            );
            response.once('error', reject);
          },
        );
        request.once('error', reject);
        request.write(bytes.subarray(0, 417));
        request.end(bytes.subarray(417));
      });
      expect(outcome.status).toBe(413);
      expect(JSON.parse(outcome.body) as object).toHaveProperty('error', 'file-too-large');
    } finally {
      await limited.close();
    }
  });
});
