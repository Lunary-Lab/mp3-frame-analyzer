import { request as httpRequest, type IncomingMessage } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { withUploadCancellation } from '../src/upload-cancellation.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
});
function client(address: string, length = 64) {
  const request = httpRequest(address + '/cancellation', {
    method: 'POST',
    headers: { 'content-type': 'audio/mpeg', 'content-length': String(length) },
  });
  request.on('error', () => {}); // These tests deliberately disconnect before a response.
  request.setTimeout(2000, () => request.destroy());
  return request;
}
async function readBody(request: IncomingMessage) {
  for await (const chunk of request as AsyncIterable<unknown>) expect(chunk).toBeInstanceOf(Buffer);
}
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

it('does not confuse EOF with abort, but cancels if the peer disconnects after the full body arrived', async () => {
  const app = await buildApp();
  apps.push(app);
  const eof = Promise.withResolvers<{ signal: AbortSignal; complete: boolean }>();
  const stopped = Promise.withResolvers<unknown>();
  app.post('/cancellation', async (request, reply) => {
    try {
      return await withUploadCancellation(request.raw, reply.raw, async (signal) => {
        await readBody(request.raw);
        await nextTurn(); // Let the normal IncomingMessage close event run too.
        eof.resolve({ signal, complete: request.raw.complete });
        await untilAborted(signal);
        signal.throwIfAborted();
        return { unreachable: true };
      });
    } catch (error) {
      stopped.resolve(error);
      throw error;
    }
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const sender = client(address);
  sender.end(Buffer.alloc(64));
  const state = await eof.promise;
  expect(state.complete).toBe(true);
  expect(state.signal.aborted).toBe(false);
  sender.destroy();
  expect(await stopped.promise).toMatchObject({ name: 'AbortError' });
  expect(state.signal.aborted).toBe(true);
});

it('cancels a consumer when the client disconnects before request EOF', async () => {
  const app = await buildApp();
  apps.push(app);
  const started = Promise.withResolvers<AbortSignal>();
  const stopped = Promise.withResolvers<void>();
  app.post('/cancellation', async (request, reply) => {
    try {
      return await withUploadCancellation(request.raw, reply.raw, async (signal) => {
        started.resolve(signal);
        await readBody(request.raw);
        return { done: true };
      });
    } finally {
      stopped.resolve();
    }
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const sender = client(address);
  sender.write(Buffer.alloc(1));
  const signal = await started.promise;
  expect(signal.aborted).toBe(false);
  sender.destroy();
  await stopped.promise;
  expect(signal.aborted).toBe(true);
});

it('cancels still-running work after an early response without replacing that response', async () => {
  const app = await buildApp();
  apps.push(app);
  const stopped = Promise.withResolvers<unknown>();
  app.post('/cancellation', (request, reply) => {
    const operation = withUploadCancellation(request.raw, reply.raw, async (signal) => {
      await untilAborted(signal);
      signal.throwIfAborted();
    });
    // Simulate the existing multipart-budget race while explicitly observing its consumer.
    void operation.then(() => stopped.resolve(undefined), stopped.resolve);
    return reply.header('connection', 'close').status(413).send({ error: 'request-too-large' });
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(address + '/cancellation', {
    method: 'POST',
    headers: { 'content-type': 'audio/mpeg' },
    body: new Uint8Array(64),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'request-too-large' });
  expect(await stopped.promise).toMatchObject({ name: 'AbortError' });
});
