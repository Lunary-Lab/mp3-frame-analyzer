import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ClientError } from '../src/client-error.js';
import { registerUploads, type UploadConsumer } from '../src/upload.js';
import { sendPipelined } from './helpers/http.js';
import { multipartBody } from './helpers/mp3-fixtures.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Responds with the consumer's result, or with whichever error reached the route. */
async function uploadApp(consume: UploadConsumer<unknown>, maxUploadBytes = 64 * 1024) {
  const app = Fastify();
  apps.push(app);
  const uploads = await registerUploads(app, { maxUploadBytes });
  const errors: unknown[] = [];
  app.post('/file-upload', async (request, reply) => {
    try {
      return { result: await uploads.consume(request, reply, consume) };
    } catch (error) {
      errors.push(error);
      const status = error instanceof ClientError ? error.status : 422;
      return reply.status(status).send({ error: (error as Error).message });
    }
  });
  return { app, errors };
}

async function collect(upload: AsyncIterable<Uint8Array>): Promise<number[]> {
  const bytes: number[] = [];
  for await (const chunk of upload) bytes.push(...chunk);
  return bytes;
}

const stopped = new Error('consumer stopped');
async function stopAfterFirstChunk(upload: AsyncIterable<Uint8Array>): Promise<never> {
  for await (const chunk of upload) if (chunk.length > 0) break;
  throw stopped;
}

const raw = (payload: Buffer | Readable, headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url: '/file-upload',
  headers: { 'content-type': 'audio/mpeg', ...headers },
  payload,
});
const multipart = (bytes: Buffer, options?: Parameters<typeof multipartBody>[1]) => {
  const { contentType, payload } = multipartBody(bytes, options);
  return raw(payload, { 'content-type': contentType });
};

it('feeds the consumer the same bytes from a raw and a multipart upload', async () => {
  const { app } = await uploadApp(collect);
  const bytes = Buffer.from([0, 1, 2, 0x0d, 0x0a, 0x2d, 0x2d, 250, 255]);
  for (const request of [raw(bytes), multipart(bytes)]) {
    const response = await app.inject(request);
    expect(response.json()).toEqual({ result: [...bytes] });
  }
});

const bodiless = {
  method: 'POST' as const,
  url: '/file-upload',
  headers: { 'content-type': 'text/plain' },
};

it.each([
  ['a bodiless request of another media type', bodiless, 415],
  ['a raw upload declared over the limit', raw(Buffer.alloc(2048)), 413, 'close'],
  ['a multipart upload under another field', multipart(Buffer.alloc(8), { field: 'f' }), 400],
  [
    'a multipart upload of another media type',
    multipart(Buffer.alloc(8), { mime: 'text/plain' }),
    415,
  ],
] as const)('rejects %s before the consumer runs', async (_, request, status, connection?) => {
  const consume = vi.fn(collect);
  const { app } = await uploadApp(consume, 1024);
  const response = await app.inject(request);
  expect(response.statusCode).toBe(status);
  expect(response.headers.connection).toBe(connection ?? 'keep-alive');
  expect(consume).not.toHaveBeenCalled();
});

/** Reads everything, then rejects the ending, as a parser does a truncated last frame. */
async function rejectEnding(upload: AsyncIterable<Uint8Array>): Promise<never> {
  await collect(upload);
  throw new Error('incomplete ending');
}

const tooLarge = { error: 'File exceeds configured upload limit' };

it('fails the consumer at the limit of a raw upload streamed without a size', async () => {
  const { app, errors } = await uploadApp(collect, 1024);
  const unsized = Readable.from([Buffer.alloc(1000), Buffer.alloc(1000)]);
  const response = await app.inject(raw(unsized));
  expect(response.statusCode).toBe(413);
  expect(response.json()).toEqual(tooLarge);
  expect(response.headers.connection).toBe('close');
  expect(errors).toEqual([expect.objectContaining({ code: 'file-too-large' })]);
});

it.each([
  { behaviour: 'returns normally', consumer: collect },
  { behaviour: 'rejects the ending', consumer: rejectEnding },
])(
  'reports a multipart upload cut off at the limit as file-too-large when the consumer $behaviour',
  async ({ consumer }) => {
    const { app } = await uploadApp(consumer, 1024);
    const response = await app.inject(multipart(Buffer.alloc(2048)));
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual(tooLarge);
    expect(response.headers.connection).toBe('keep-alive');
  },
);

it('passes a consumer failure through and closes a raw upload connection', async () => {
  const { app, errors } = await uploadApp(stopAfterFirstChunk);
  const response = await app.inject(raw(Buffer.alloc(4096)));
  expect(response.statusCode).toBe(422);
  expect(response.headers.connection).toBe('close');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBe(stopped);
});

it('drains a multipart upload whatever stopped its consumer, keeping the connection', async () => {
  // Larger than loopback socket buffers: the consumer stops while most of the
  // upload is still unread, so only a drained remainder lets request two parse.
  const { app, errors } = await uploadApp(stopAfterFirstChunk, 32 * 1024 * 1024);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const responses = await sendPipelined(address, [
    multipartBody(Buffer.alloc(16 * 1024 * 1024)),
    multipartBody(Buffer.alloc(16)),
  ]);
  expect(responses).toEqual([
    { status: 422, body: { error: 'consumer stopped' } },
    { status: 422, body: { error: 'consumer stopped' } },
  ]);
  expect(errors).toEqual([stopped, stopped]);
});
