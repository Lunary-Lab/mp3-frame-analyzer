import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerUploads, type UploadConsumer } from '../src/upload.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function observeIterator(consumer: UploadConsumer<unknown>, returnFailure?: Error) {
  let next = 0;
  const ended = vi.fn();
  const cleanup = vi.fn(async () => {
    if (returnFailure) throw returnFailure;
    return { value: undefined, done: true as const };
  });
  const iterator = {
    async next() {
      if (++next <= 2) return { value: Buffer.from([next]), done: false as const };
      ended();
      return { value: undefined, done: true as const };
    },
    return: cleanup,
    async [Symbol.asyncDispose]() {
      await cleanup();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const stream = new Readable({ read() {} });
  const createIterator = vi.spyOn(stream, 'iterator').mockReturnValue(iterator);
  const app = Fastify();
  apps.push(app);
  const uploads = await registerUploads(app, { maxUploadBytes: 64 });
  const log = vi.spyOn(app.log, 'error');
  const errors: unknown[] = [];
  app.addHook('preHandler', async (request) => {
    request.body = stream;
  });
  app.post('/file-upload', async (request, reply) => {
    try {
      return { result: await uploads.consume(request, reply, consumer) };
    } catch (error) {
      errors.push(error);
      return reply.status(500).send({ error: 'sanitized' });
    }
  });
  const response = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'audio/mpeg' },
    payload: Buffer.from([1]),
  });
  return { response, ended, cleanup, errors, log, createIterator };
}

it('EOF completes the native iterator once without redundant return calls', async () => {
  const observed = await observeIterator(async (upload) => {
    let count = 0;
    for await (const chunk of upload) count += chunk.length;
    return count;
  });
  expect(observed.response.json()).toEqual({ result: 2 });
  expect(observed.ended).toHaveBeenCalledTimes(1);
  expect(observed.cleanup).not.toHaveBeenCalled();
});

it.each(['success', 'rejection', 'break'] as const)(
  'closes a started iterator once on %s',
  async (mode) => {
    const primary = new Error('primary');
    const observed = await observeIterator(async (upload) => {
      if (mode === 'break') {
        for await (const chunk of upload) if (chunk.length) break;
      } else {
        await upload[Symbol.asyncIterator]().next();
      }
      if (mode === 'rejection') throw primary;
      return 7;
    });
    expect(observed.cleanup).toHaveBeenCalledTimes(1);
    expect(observed.ended).not.toHaveBeenCalled();
    expect(observed.response.headers.connection).toBe('close');
    expect(observed.errors).toEqual(mode === 'rejection' ? [primary] : []);
  },
);

it('does not initialize a native iterator when the consumer never reads', async () => {
  const observed = await observeIterator(async () => 7);
  expect(observed.createIterator).not.toHaveBeenCalled();
  expect(observed.cleanup).not.toHaveBeenCalled();
  expect(observed.response.headers.connection).toBe('close');
});

it('propagates a cleanup rejection after consumer success instead of reporting success', async () => {
  const failure = new Error('cleanup failed');
  const observed = await observeIterator(async (upload) => {
    await upload[Symbol.asyncIterator]().next();
    return 7;
  }, failure);
  expect(observed.cleanup).toHaveBeenCalledTimes(1);
  expect(observed.errors).toEqual([failure]);
  expect(observed.response.statusCode).toBe(500);
  expect(observed.response.json()).toEqual({ error: 'sanitized' });
});

it('logs cleanup rejection without masking an earlier consumer rejection', async () => {
  const primary = new Error('consumer failed');
  const secondary = new Error('cleanup failed');
  const observed = await observeIterator(async (upload) => {
    await upload[Symbol.asyncIterator]().next();
    throw primary;
  }, secondary);
  expect(observed.cleanup).toHaveBeenCalledTimes(1);
  expect(observed.errors).toEqual([primary]);
  expect(observed.log).toHaveBeenCalledExactlyOnceWith(
    { err: secondary },
    'Upload iterator cleanup failed',
  );
});
