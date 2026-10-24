import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { frame, mp3 } from './helpers/mp3-fixtures.js';

let app: FastifyInstance;
let baseUrl: string;
beforeAll(async () => {
  app = await buildApp();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = address;
});
afterAll(async () => {
  await app.close();
});

it('accepts multipart/form-data over a real TCP server using native fetch', async () => {
  const form = new FormData();
  form.set(
    'file',
    new Blob([new Uint8Array(mp3([frame(), frame()]))], { type: 'audio/mpeg' }),
    'sound.mp3',
  );
  const response = await fetch(`${baseUrl}/file-upload`, { method: 'POST', body: form });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ frameCount: 2 });
});
