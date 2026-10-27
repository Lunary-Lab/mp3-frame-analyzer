import { setImmediate as nextTurn } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { frame, multipartBody } from './helpers/mp3-fixtures.js';
import { openUpload } from './helpers/upload-socket.js';

vi.mock('../src/mp3/count-frames.js', () => ({ countMp3Frames: vi.fn() }));
const count = vi.mocked(countMp3Frames);
const apps: FastifyInstance[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
  count.mockReset();
});

function deferred() {
  const result = Promise.withResolvers<void>();
  releases.push(result.resolve);
  return result;
}
async function server(limits = {}) {
  const app = await buildApp({ maxActiveUploads: 1, ...limits });
  apps.push(app);
  return { app, address: await app.listen({ host: '127.0.0.1', port: 0 }) };
}
async function recover(app: FastifyInstance) {
  count.mockImplementation(async (input) => {
    for await (const chunk of input) expect(chunk.byteLength).toBeGreaterThan(0);
    return 1;
  });
  await expect
    .poll(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/file-upload',
        headers: { 'content-type': 'audio/mpeg' },
        payload: frame(),
      });
      return response.statusCode;
    })
    .toBe(200);
}

it('passes cancellation and the existing count policy through the real upload route', async () => {
  const { app } = await server();
  count.mockResolvedValue(7);
  for (const [query, include] of [
    ['', false],
    ['?includeVbrHeaderFrame=true', true],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/file-upload' + query,
      headers: { 'content-type': 'audio/mpeg' },
      payload: frame(),
    });
    expect(response.json()).toEqual({ frameCount: 7 });
    const signal = count.mock.lastCall?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(count).toHaveBeenLastCalledWith(expect.anything(), {
      includeVbrHeaderFrame: include,
      signal,
    });
    expect(signal?.aborted).toBe(false);
  }
});

it.each(['raw', 'multipart'])(
  'cancels buffered %s work after peer close and recovers capacity',
  async (form) => {
    const { app, address } = await server();
    const ready = deferred();
    const aborted = deferred();
    const stopped = deferred();
    let signal: AbortSignal | undefined;
    count.mockImplementation(async (input, options) => {
      try {
        signal = options?.signal;
        signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        for await (const chunk of input) expect(chunk.byteLength).toBeGreaterThan(0);
        await nextTurn(); // Normal raw EOF/close must not be mistaken for cancellation.
        ready.resolve();
        await aborted.promise;
        signal?.throwIfAborted();
        return 1;
      } finally {
        stopped.resolve();
      }
    });
    const body = multipartBody(frame());
    const payload = form === 'raw' ? frame() : body.payload;
    const sender = openUpload(
      address,
      form === 'raw' ? 'audio/mpeg' : body.contentType,
      payload.length,
    );
    sender.client.end(payload);
    await ready.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    sender.client.destroy();
    await stopped.promise;
    expect(signal?.aborted).toBe(true);
    await recover(app);
  },
);

it('keeps cancellation attached after the multipart budget wins the response race', async () => {
  const { app, address } = await server({ maxMultipartBytes: 4096 });
  const started = deferred();
  const aborted = deferred();
  const stopped = deferred();
  let signal: AbortSignal | undefined;
  count.mockImplementation(async (input, options) => {
    try {
      signal = options?.signal;
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      for await (const chunk of input) {
        expect(chunk.byteLength).toBeGreaterThan(0);
        started.resolve();
        await aborted.promise;
        signal?.throwIfAborted();
      }
      return 1;
    } finally {
      stopped.resolve();
    }
  });
  const body = multipartBody(Buffer.alloc(16 * 1024));
  const sender = openUpload(address, body.contentType);
  sender.client.write(body.payload.subarray(0, 1024));
  await started.promise;
  sender.client.end(body.payload.subarray(1024));
  expect((await sender.response).status).toBe(413);
  await stopped.promise;
  expect(signal?.aborted).toBe(true);
  await recover(app);
});

it('allows a consumer to finish during graceful shutdown without inventing an abort', async () => {
  const { app, address } = await server();
  const ready = deferred();
  const finish = deferred();
  let signal: AbortSignal | undefined;
  count.mockImplementation(async (input, options) => {
    signal = options?.signal;
    for await (const chunk of input) expect(chunk.byteLength).toBeGreaterThan(0);
    ready.resolve();
    await finish.promise;
    signal?.throwIfAborted();
    return 1;
  });
  const sender = openUpload(address, 'audio/mpeg', 417);
  sender.client.end(frame());
  await ready.promise;
  let closed = false;
  const shutdown = app.close().then(() => {
    closed = true;
  });
  await nextTurn();
  expect(closed).toBe(false);
  expect(signal?.aborted).toBe(false);
  finish.resolve();
  expect(await sender.response).toMatchObject({ status: 200, body: { frameCount: 1 } });
  await shutdown;
  expect(signal?.aborted).toBe(false);
});
