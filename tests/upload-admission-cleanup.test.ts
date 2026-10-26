import Fastify, { type FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createUploadAdmission } from '../src/upload-admission.js';
import { closeWithDeadline } from '../src/shutdown.js';
import { registerUploads } from '../src/upload.js';
import { errorResponseFor } from '../src/error-response.js';
import { frame, multipartBody } from './helpers/mp3-fixtures.js';
import { openUpload } from './helpers/upload-socket.js';

const apps: FastifyInstance[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
});

it('holds a permit after overflow and transport close until delayed consumer and parts settle', async () => {
  const app = Fastify();
  apps.push(app);
  const uploads = await registerUploads(app, {
    maxUploadBytes: 1024 * 1024,
    maxMultipartBytes: 64 * 1024,
  });
  const admission = createUploadAdmission(app, uploads, 1);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  let partsDone = 0;
  let consumerDone = 0;
  let raw: IncomingMessage | undefined;
  app.post('/file-upload', { onRequest: admission.onRequest }, async (request, reply) => {
    raw = request.raw;
    const parts = request.parts.bind(request);
    request.parts = async function* (options) {
      try {
        yield* parts(options);
      } finally {
        partsDone++;
      }
    };
    return admission.run(request, () =>
      uploads.consume(request, reply, async (upload) => {
        try {
          for await (const chunk of upload) {
            expect(chunk.byteLength).toBeGreaterThan(0);
            started.resolve();
            await release.promise;
          }
        } finally {
          consumerDone++;
        }
        return { frameCount: 1 };
      }),
    );
  });
  app.setErrorHandler((error, _request, reply) => {
    const response = errorResponseFor(error, 'multipart');
    if (response.closeConnection) reply.header('connection', 'close');
    return reply.status(response.status).send(response.body);
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const form = multipartBody(Buffer.alloc(256 * 1024));
  const incoming = openUpload(address, form.contentType);
  incoming.client.write(form.payload.subarray(0, 1024));
  await started.promise;
  incoming.client.end(form.payload.subarray(1024));
  expect((await incoming.response).status).toBe(413);
  await incoming.closed;
  expect(raw?.destroyed).toBe(true);
  expect({ consumerDone, partsDone }).toEqual({ consumerDone: 0, partsDone: 0 });
  const rejected = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'audio/mpeg' },
    payload: frame(),
  });
  expect(rejected.statusCode).toBe(503);
  release.resolve();
  await expect.poll(() => ({ consumerDone, partsDone })).toEqual({ consumerDone: 1, partsDone: 1 });
  await expect
    .poll(
      async () =>
        (
          await app.inject({
            method: 'POST',
            url: '/file-upload',
            headers: { 'content-type': 'audio/mpeg' },
            payload: frame(),
          })
        ).statusCode,
    )
    .toBe(200);
});

it('holds capacity during an early multipart parse error until the unread remainder drains', async () => {
  const app = Fastify();
  apps.push(app);
  const uploads = await registerUploads(app, { maxUploadBytes: 1024 * 1024 });
  const admission = createUploadAdmission(app, uploads, 1);
  app.post('/file-upload', { onRequest: admission.onRequest }, async (request, reply) =>
    admission.run(request, () =>
      uploads.consume(request, reply, async (upload) => {
        for await (const chunk of upload) {
          expect(chunk.byteLength).toBeGreaterThan(0);
          throw new Error('consumer failure');
        }
        return { frameCount: 1 };
      }),
    ),
  );
  app.setErrorHandler((_error, _request, reply) =>
    reply.status(500).send({ error: 'internal-error' }),
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const form = multipartBody(Buffer.alloc(64 * 1024));
  const incoming = openUpload(address, form.contentType);
  incoming.client.write(form.payload.subarray(0, 1024));
  expect((await incoming.response).status).toBe(500);
  const overloaded = await app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'audio/mpeg' },
    payload: frame(),
  });
  expect(overloaded.statusCode).toBe(503);
  incoming.client.end(form.payload.subarray(1024));
  await expect
    .poll(
      async () =>
        (
          await app.inject({
            method: 'POST',
            url: '/file-upload',
            headers: { 'content-type': 'audio/mpeg' },
            payload: Buffer.alloc(0),
          })
        ).statusCode,
    )
    .toBe(500);
});

it('close waits after transport teardown for admitted work still awaiting consumer cleanup', async () => {
  const app = Fastify();
  apps.push(app);
  const uploads = await registerUploads(app, {
    maxUploadBytes: 1024 * 1024,
    maxMultipartBytes: 4096,
  });
  const admission = createUploadAdmission(app, uploads, 1);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  let consumerDone = false;
  app.post('/file-upload', { onRequest: admission.onRequest }, async (request, reply) =>
    admission.run(request, () =>
      uploads.consume(request, reply, async (upload) => {
        try {
          for await (const chunk of upload) {
            expect(chunk.byteLength).toBeGreaterThan(0);
            started.resolve();
            await release.promise;
          }
        } finally {
          consumerDone = true;
        }
        return { frameCount: 1 };
      }),
    ),
  );
  app.setErrorHandler((error, _request, reply) => {
    const response = errorResponseFor(error, 'multipart');
    return reply.header('connection', 'close').status(response.status).send(response.body);
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const form = multipartBody(Buffer.alloc(16 * 1024));
  const incoming = openUpload(address, form.contentType);
  incoming.client.write(form.payload.subarray(0, 1024));
  await started.promise;
  incoming.client.end(form.payload.subarray(1024));
  expect((await incoming.response).status).toBe(413);
  await incoming.closed;
  let closed = false;
  const completion = app.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(consumerDone).toBe(false);
  expect(closed).toBe(false);
  await expect(closeWithDeadline(app, 20)).rejects.toThrow('Server shutdown exceeded 20 ms');
  expect(consumerDone).toBe(false);
  release.resolve();
  await completion;
  expect(consumerDone).toBe(true);
  expect(closed).toBe(true);
});
