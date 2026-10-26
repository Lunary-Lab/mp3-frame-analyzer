import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { registerUploads } from '../src/upload.js';
import { errorResponseFor } from '../src/error-response.js';
import { multipartBody } from './helpers/mp3-fixtures.js';
import { openUpload } from './helpers/upload-socket.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      app.server.closeAllConnections();
      await app.close();
    }),
  );
});

it.each([
  [false, false, 200],
  [false, true, 413],
  [true, false, 400],
  [true, true, 413],
] as const)(
  'finishes consumer and parts iterators after buffered EOF (incomplete:%s, overflow:%s)',
  async (incomplete, overflow, status) => {
    const app = Fastify();
    apps.push(app);
    const form = multipartBody(Buffer.alloc(256 * 1024));
    if (incomplete) form.payload = form.payload.subarray(0, form.payload.lastIndexOf('\r\n--'));
    const uploads = await registerUploads(app, {
      maxUploadBytes: form.payload.length,
      maxMultipartBytes: form.payload.length + (overflow ? -1 : 1),
    });
    let raw: IncomingMessage | undefined;
    let partsDone = 0;
    let consumerDone = 0;
    app.post('/file-upload', async (request, reply) => {
      raw = request.raw;
      const parts = request.parts.bind(request);
      request.parts = async function* (options) {
        try {
          yield* parts(options);
        } finally {
          partsDone++;
        }
      };
      return {
        result: await uploads.consume(request, reply, async (upload) => {
          let bytes = 0;
          try {
            for await (const chunk of upload) {
              bytes += chunk.length;
              // Cooperatively slow consumption lets the bounded HTTP body arrive
              // completely while multipart backpressure still holds file chunks.
              await delay(20);
            }
          } finally {
            consumerDone++;
          }
          return bytes;
        }),
      };
    });
    app.setErrorHandler((error, _request, reply) => {
      const response = errorResponseFor(error, 'multipart');
      if (response.closeConnection) reply.header('connection', 'close');
      return reply.status(response.status).send(response.body);
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const upload = openUpload(address, form.contentType);
    try {
      upload.client.write(form.payload.subarray(0, 1));
      upload.client.end(form.payload.subarray(1));
      expect((await upload.response).status).toBe(status);
      await expect
        .poll(() => ({ partsDone, consumerDone }), { timeout: 1000 })
        .toEqual({ partsDone: 1, consumerDone: 1 });
      expect(raw?.complete).toBe(true);
      expect(raw?.readableEnded).toBe(true);
      expect(raw?.aborted).toBe(false);
    } finally {
      upload.client.destroy();
    }
  },
);

it('holds real multipart backpressure paused while an overflow response is delayed', async () => {
  const app = Fastify();
  apps.push(app);
  const form = multipartBody(Buffer.alloc(256 * 1024));
  const limit = 64 * 1024;
  const uploads = await registerUploads(app, {
    maxUploadBytes: form.payload.length,
    maxMultipartBytes: limit,
  });
  let delivered = 0;
  let crossed = false;
  let chunksAfterCrossing = 0;
  let resumesAfterCrossing = 0;
  let consumerDone = 0;
  app.addHook('preHandler', async (request) => {
    request.raw.pause();
    request.raw.on('data', (chunk: Buffer) => {
      if (crossed) chunksAfterCrossing++;
      delivered += chunk.length;
      crossed ||= delivered > limit;
    });
    request.raw.on('resume', () => {
      if (crossed) resumesAfterCrossing++;
    });
  });
  app.addHook('onSend', async (_request, _reply, payload) => {
    await delay(150); // Let the parser's drain try to resume before response closure.
    return payload;
  });
  app.post('/file-upload', async (request, reply) =>
    uploads.consume(request, reply, async (upload) => {
      try {
        for await (const chunk of upload) {
          expect(chunk.length).toBeGreaterThan(0);
          await delay(20);
        }
      } finally {
        consumerDone++;
      }
      return { done: true };
    }),
  );
  app.setErrorHandler((error, _request, reply) => {
    const response = errorResponseFor(error, 'multipart');
    return reply.status(response.status).send(response.body);
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const upload = openUpload(address, form.contentType);
  try {
    upload.client.write(form.payload.subarray(0, 1));
    upload.client.end(form.payload.subarray(1));
    expect(await upload.response).toMatchObject({ status: 413, connection: 'close' });
    expect(crossed).toBe(true);
    expect(resumesAfterCrossing).toBeGreaterThan(0);
    expect(chunksAfterCrossing).toBe(0);
    await expect.poll(() => consumerDone, { timeout: 1000 }).toBe(1);
  } finally {
    upload.client.destroy();
  }
});
