import { setImmediate as nextTurn } from 'node:timers/promises';
import { connect } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { errorResponseFor } from '../src/error-response.js';
import { registerUploads, type UploadConsumer } from '../src/upload.js';
import { frame, multipartBody } from './helpers/mp3-fixtures.js';
import { openUpload } from './helpers/upload-socket.js';
import { sendPipelined } from './helpers/http.js';

const apps: FastifyInstance[] = [];
const clients: ClientRequest[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(
    apps.splice(0).map(async (app) => {
      app.server.closeAllConnections();
      await app.close();
    }),
  );
});

async function listener(options: { maxUploadBytes: number; maxMultipartBytes: number }) {
  const app = await buildApp(options);
  apps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address };
}

function open(address: string, contentType: string, length?: number) {
  const upload = openUpload(address, contentType, length);
  clients.push(upload.client);
  return upload;
}

async function customListener(consumer: UploadConsumer<unknown>, maxMultipartBytes = 4096) {
  const app = Fastify({ connectionTimeout: 100 });
  apps.push(app);
  const uploads = await registerUploads(app, { maxUploadBytes: 2048, maxMultipartBytes });
  const raw = Promise.withResolvers<IncomingMessage>();
  app.post('/file-upload', async (request, reply) => {
    raw.resolve(request.raw);
    return { result: await uploads.consume(request, reply, consumer) };
  });
  app.setErrorHandler((error, request, reply) => {
    if (request.raw.aborted) return reply;
    const response = errorResponseFor(error, request.isMultipart() ? 'multipart' : 'raw');
    if (response.closeConnection) reply.header('connection', 'close');
    return reply.status(response.status).send(response.body);
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, raw: raw.promise };
}

const aggregateError = {
  error: 'request-too-large',
  message: 'Multipart body exceeds configured upload limit',
};

it.each(['declared', 'chunked'] as const)(
  'counts the entire %s multipart body below, exactly at and above its budget',
  async (framing) => {
    const { payload, contentType } = multipartBody(frame());
    const limit = payload.length;
    const { address } = await listener({ maxUploadBytes: 1024, maxMultipartBytes: limit });
    for (const difference of [-1, 0, 1]) {
      // The optional final CRLF is envelope, not file bytes.
      const body =
        difference < 0
          ? payload.subarray(0, -1)
          : Buffer.concat([payload, Buffer.alloc(difference, 0x20)]);
      const upload = open(address, contentType, framing === 'declared' ? body.length : undefined);
      upload.client.end(body);
      const response = await upload.response;
      expect(response.status, `${framing}: ${difference}`).toBe(difference > 0 ? 413 : 200);
      expect(response.body).toEqual(difference > 0 ? aggregateError : { frameCount: 1 });
      if (difference > 0) expect(response.connection).toBe('close');
    }
  },
);

it('rejects an oversized multipart declaration without waiting for any body bytes', async () => {
  const { address } = await listener({ maxUploadBytes: 1024, maxMultipartBytes: 512 });
  const upload = open(address, multipartBody(frame()).contentType, 513);
  upload.client.flushHeaders();
  expect(await upload.response).toEqual({ status: 413, body: aggregateError, connection: 'close' });
  await upload.closed;
});

it.each(['preamble', 'epilogue'] as const)(
  'counts excess %s even outside the accepted file',
  async (where) => {
    const form = multipartBody(frame());
    const extra = Buffer.alloc(65, 0x20);
    const payload =
      where === 'preamble'
        ? Buffer.concat([extra, Buffer.from('\r\n'), form.payload])
        : Buffer.concat([form.payload, extra]);
    const { address } = await listener({
      maxUploadBytes: 1024,
      maxMultipartBytes: form.payload.length + 64,
    });
    const upload = open(address, form.contentType);
    upload.client.end(payload);
    expect(await upload.response).toMatchObject({
      status: 413,
      body: aggregateError,
      connection: 'close',
    });
  },
);

it('preserves an early audio 422 then closes when the discarded chunked remainder exceeds budget', async () => {
  const form = multipartBody(Buffer.from('NOPE'));
  const prefix = form.payload.subarray(0, form.payload.lastIndexOf('\r\n--'));
  const { address } = await listener({ maxUploadBytes: 4, maxMultipartBytes: prefix.length + 16 });
  const upload = open(address, form.contentType);
  upload.client.write(prefix);
  expect(await upload.response).toMatchObject({ status: 422, body: { error: 'invalid-mp3' } });
  upload.client.write(Buffer.alloc(17));
  await upload.closed;
  const next = open(address, 'audio/mpeg');
  next.client.end(frame().subarray(0, 4));
  expect((await next.response).status).toBe(422);
});

it.each([
  ['untouched', 'declared'],
  ['one chunk', 'declared'],
  ['untouched', 'chunked'],
  ['one chunk', 'chunked'],
] as const)(
  'closes raw early success with %s input without awaiting EOF (%s)',
  async (mode, framing) => {
    const { address } = await customListener(async (upload) => {
      if (mode === 'one chunk') await upload[Symbol.asyncIterator]().next();
      return 7;
    });
    const upload = open(address, 'audio/mpeg', framing === 'declared' ? 1024 : undefined);
    upload.client.write(Buffer.alloc(16));
    expect(await upload.response).toEqual({
      status: 200,
      body: { result: 7 },
      connection: 'close',
    });
    await upload.closed;
  },
);

it.each(['untouched', 'one chunk'] as const)(
  'finishes multipart early success with %s input before reusing the connection',
  async (mode) => {
    const consumed = Promise.withResolvers<void>();
    const { address } = await customListener(async (upload) => {
      if (mode === 'one chunk') await upload[Symbol.asyncIterator]().next();
      consumed.resolve();
      return 7;
    });
    const form = multipartBody(Buffer.alloc(512));
    const upload = open(address, form.contentType, form.payload.length);
    const arrived = vi.fn();
    void upload.response.then(arrived, () => {});
    upload.client.write(form.payload.subarray(0, -128));
    await consumed.promise;
    await nextTurn();
    expect(arrived).not.toHaveBeenCalled();
    upload.client.end(form.payload.subarray(-128));
    expect(await upload.response).toMatchObject({ status: 200, body: { result: 7 } });
    expect(await sendPipelined(address, [form, form])).toEqual([
      { status: 200, body: { result: 7 } },
      { status: 200, body: { result: 7 } },
    ]);
  },
);

it('does not accept a successful early consumer when the remaining multipart body exceeds budget', async () => {
  const { address } = await customListener(async () => 7, 256);
  const form = multipartBody(Buffer.alloc(128));
  const upload = open(address, form.contentType);
  upload.client.end(form.payload);
  expect(await upload.response).toEqual({ status: 413, body: aggregateError, connection: 'close' });
});

it.each([false, true])(
  'drains an already truncated file after early rejection (read: %s)',
  async (read) => {
    const { address } = await customListener(async (upload) => {
      if (read) await upload[Symbol.asyncIterator]().next();
      throw new Error('consumer rejected');
    }, 8192);
    const form = multipartBody(Buffer.alloc(4096));
    const upload = open(address, form.contentType);
    upload.client.end(form.payload);
    expect(await upload.response).toMatchObject({ status: 413, body: { error: 'file-too-large' } });
    expect(await sendPipelined(address, [form, form])).toEqual([
      {
        status: 413,
        body: { error: 'file-too-large', message: 'File exceeds configured upload limit' },
      },
      {
        status: 413,
        body: { error: 'file-too-large', message: 'File exceeds configured upload limit' },
      },
    ]);
  },
);

it('awaits and counts a separately arriving epilogue before returning success', async () => {
  const form = multipartBody(frame());
  const { address } = await listener({
    maxUploadBytes: 1024,
    maxMultipartBytes: form.payload.length + 8,
  });
  const upload = open(address, form.contentType);
  const arrived = vi.fn();
  void upload.response.then(arrived, () => {});
  upload.client.write(form.payload);
  await nextTurn();
  expect(arrived).not.toHaveBeenCalled();
  upload.client.end(Buffer.alloc(9, 0x20));
  expect(await upload.response).toEqual({ status: 413, body: aggregateError, connection: 'close' });
});

it.each(['abort', 'idle timeout'] as const)(
  'removes its body guard after %s and serves the next client',
  async (ending) => {
    const { address, raw } = await customListener(async (upload) => {
      let bytes = 0;
      for await (const chunk of upload) bytes += chunk.length;
      return bytes;
    });
    const form = multipartBody(Buffer.alloc(512));
    const upload = open(address, form.contentType, form.payload.length);
    let clientTimedOut = false;
    upload.client.once('timeout', () => {
      clientTimedOut = true;
    });
    upload.client.write(form.payload.subarray(0, -128));
    const serverRequest = await raw;
    const closed = new Promise<void>((resolve) => serverRequest.once('close', resolve));
    expect(serverRequest.listeners('data').some((fn) => fn.name === 'onData')).toBe(true);
    if (ending === 'abort') upload.client.destroy();
    await closed;
    // Neither ending may be supplied by the test client's fallback watchdog.
    expect(clientTimedOut).toBe(false);
    expect(serverRequest.aborted).toBe(true);
    expect(serverRequest.listeners('data').some((fn) => fn.name === 'onData')).toBe(false);
    expect(serverRequest.listeners('close').some((fn) => fn.name === 'cleanup')).toBe(false);
    const followup = open(address, form.contentType, form.payload.length);
    followup.client.end(form.payload);
    expect(await followup.response).toMatchObject({ status: 200, body: { result: 512 } });
  },
);

it('reports an incomplete body after early consumer success rather than accepting it', async () => {
  const { address } = await customListener(async () => 7);
  const form = multipartBody(Buffer.alloc(512));
  const incomplete = form.payload.subarray(0, form.payload.lastIndexOf('\r\n--'));
  const upload = open(address, form.contentType, incomplete.length);
  upload.client.end(incomplete);
  expect(await upload.response).toMatchObject({ status: 400, body: { error: 'invalid-upload' } });
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid embedded aggregate limit %s',
  async (maxMultipartBytes) => {
    await expect(buildApp({ maxMultipartBytes })).rejects.toThrow(
      'maxMultipartBytes must be a positive safe integer',
    );
  },
);

it('still rejects an empty multipart file when a successful consumer never reads', async () => {
  const { address } = await customListener(async () => 7);
  const form = multipartBody(Buffer.alloc(0));
  const upload = open(address, form.contentType);
  upload.client.end(form.payload);
  expect(await upload.response).toMatchObject({ status: 400, body: { error: 'empty-file' } });
});

it.each(['declared', 'chunked'] as const)(
  'closes after one aggregate error instead of answering a pipelined request (%s)',
  async (framing) => {
    const form = multipartBody(frame());
    const { address } = await listener({
      maxUploadBytes: 1024,
      maxMultipartBytes: form.payload.length,
    });
    const payload = Buffer.concat([form.payload, Buffer.from(' ')]);
    const socket = connect(Number(new URL(address).port), '127.0.0.1');
    try {
      const closed = Promise.withResolvers<string>();
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
      });
      socket.once('close', () => closed.resolve(received));
      socket.once('error', closed.reject);
      socket.setTimeout(2000, () =>
        socket.destroy(new Error('Pipelined budget response timed out')),
      );
      const framingHeader =
        framing === 'declared' ? `Content-Length: ${payload.length}` : 'Transfer-Encoding: chunked';
      socket.write(
        `POST /file-upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: ${form.contentType}\r\n${framingHeader}\r\n\r\n`,
      );
      if (framing === 'chunked') socket.write(`${payload.length.toString(16)}\r\n`);
      socket.write(payload);
      if (framing === 'chunked') socket.write('\r\n0\r\n\r\n');
      socket.write(
        `POST /file-upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: audio/mpeg\r\nContent-Length: ${frame().length}\r\n\r\n`,
      );
      socket.write(frame());
      const text = await closed.promise;
      expect(text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 413']);
      expect(text).toContain('"error":"request-too-large"');
      expect(text.toLowerCase()).toContain('connection: close');
    } finally {
      socket.destroy();
    }
  },
);

it('keeps raw EOF-consumer uploads reusable without losing or duplicating bytes', async () => {
  const { address } = await customListener(async (upload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of upload) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('hex');
  });
  const payload = Buffer.from([0, 1, 2, 127, 255]);
  const raw = { payload, contentType: 'audio/mpeg' };
  expect(await sendPipelined(address, [raw, raw])).toEqual([
    { status: 200, body: { result: payload.toString('hex') } },
    { status: 200, body: { result: payload.toString('hex') } },
  ]);
});

it.each([
  ['chunked', 129, 'delayed'],
  ['declared', 127, 'delayed'],
  ['chunked', 129, 'buffered'],
  ['declared', 127, 'buffered'],
] as const)(
  'closes an unread multipart protocol rejection (%s, %s bytes, %s)',
  async (framing, bodyBytes, arrival) => {
    const app = await buildApp({ maxUploadBytes: 1024, maxMultipartBytes: 128 });
    apps.push(app);
    const requests: IncomingMessage[] = [];
    app.addHook('preHandler', async (request) => {
      requests.push(request.raw);
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = connect(Number(new URL(address).port), '127.0.0.1');
    try {
      const outcome = Promise.withResolvers<string>();
      let received = '';
      let attemptedFollowup = false;
      const sendBody = () => {
        const body = Buffer.alloc(bodyBytes);
        if (framing === 'chunked') socket.write(`${body.length.toString(16)}\r\n`);
        socket.write(body);
        if (framing === 'chunked') socket.write('\r\n0\r\n\r\n');
      };
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
        // Receipt of the complete first response, not a delay or TCP connect,
        // orders the late body and follow-up attempt after protocol rejection.
        if (
          !attemptedFollowup &&
          received.includes('"message":"Invalid or incomplete multipart request"}')
        ) {
          attemptedFollowup = true;
          if (arrival === 'delayed') sendBody();
          const audio = frame();
          socket.write(
            `POST /file-upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: audio/mpeg\r\nContent-Length: ${audio.length}\r\n\r\n`,
          );
          socket.write(audio);
        }
        // A second response is an immediate public failure; do not wait for
        // the old keep-alive timeout to demonstrate unbounded body reuse.
        if ((received.match(/HTTP\/1\.1 \d{3}/g)?.length ?? 0) > 1) outcome.resolve(received);
      });
      socket.once('close', () => outcome.resolve(received));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        // The expected server close may reject these deliberately late writes.
        // Still require the complete 400, close event and teardown below.
        if (attemptedFollowup && (error.code === 'EPIPE' || error.code === 'ECONNRESET')) return;
        outcome.reject(error);
      });
      socket.setTimeout(2000, () => socket.destroy(new Error('Protocol rejection did not close')));
      const framingHeader =
        framing === 'chunked' ? 'Transfer-Encoding: chunked' : `Content-Length: ${bodyBytes}`;
      socket.write(
        `POST /file-upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: multipart/form-data\r\n${framingHeader}\r\n\r\n`,
      );
      if (arrival === 'buffered') sendBody();
      const text = await outcome.promise;
      expect(attemptedFollowup).toBe(true);
      expect(text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 400']);
      expect(text.toLowerCase()).toContain('connection: close');
      expect(requests).toHaveLength(1);
      await expect.poll(() => requests[0]!.destroyed).toBe(true);
      expect(requests[0]!.listeners('data').some((fn) => fn.name === 'onData')).toBe(false);
      expect(requests[0]!.listeners('resume').some((fn) => fn.name === 'onResume')).toBe(false);
      expect(requests[0]!.listeners('close').some((fn) => fn.name === 'cleanup')).toBe(false);
      const recovery = open(address, 'audio/mpeg');
      recovery.client.end(frame());
      expect(await recovery.response).toMatchObject({ status: 200, body: { frameCount: 1 } });
    } finally {
      socket.destroy();
    }
  },
);

it('still reuses a complete bounded multipart body after an audio-consumer rejection', async () => {
  const { address } = await listener({ maxUploadBytes: 1024, maxMultipartBytes: 4096 });
  expect(
    await sendPipelined(address, [multipartBody(Buffer.from('NOPE')), multipartBody(frame())]),
  ).toEqual([
    {
      status: 422,
      body: { error: 'invalid-mp3', message: 'Invalid MPEG-1 Layer III frame header' },
    },
    { status: 200, body: { frameCount: 1 } },
  ]);
});
