import { afterAll, beforeAll, expect, it } from 'vitest';
import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { frame, mp3, multipartBody } from './helpers/mp3-fixtures.js';

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

it('returns a JSON 400 for an incomplete multipart declaration over TCP', async () => {
  const response = await fetch(`${baseUrl}/file-upload`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data' },
    body: 'incomplete form',
  });
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({
    error: 'invalid-upload',
    message: 'Invalid or incomplete multipart request',
  });
});

it('reuses a keep-alive connection after a rejected MIME type', async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const send = (mime: string) => {
    const { payload, contentType } = multipartBody(frame(), { mime });
    return new Promise<{ status: number | undefined; body: string; reused: boolean }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${baseUrl}/file-upload`,
          {
            method: 'POST',
            agent,
            headers: { 'content-type': contentType, 'content-length': payload.length },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.once('error', reject);
            response.once('end', () =>
              resolve({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
                reused: request.reusedSocket,
              }),
            );
          },
        );
        request.once('error', reject);
        request.end(payload);
      },
    );
  };
  try {
    const rejected = await send('text/plain');
    expect(rejected.status).toBe(415);
    expect(JSON.parse(rejected.body) as unknown).toMatchObject({ error: 'unsupported-media-type' });
    const accepted = await send('audio/mpeg');
    expect(accepted.reused).toBe(true);
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body) as unknown).toEqual({ frameCount: 1 });
  } finally {
    agent.destroy();
  }
});

/** Send requests over one TCP connection; each response needs the prior body consumed. */
async function sendPipelined(
  uploads: readonly { payload: Buffer; contentType: string }[],
): Promise<{ status: number; body: unknown }[]> {
  const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1');
  try {
    let received = '';
    const responses = /HTTP\/1\.1 (\d{3})[^]*?\r\n\r\n(\{[^}]*\})/g;
    const complete = new Promise<void>((resolve, reject) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
        if (received.match(responses)?.length === uploads.length) resolve();
      });
      socket.once('error', reject);
      socket.once('close', () => reject(new Error(`Connection closed after: ${received}`)));
    });
    for (const { payload, contentType } of uploads) {
      socket.write(
        `POST /file-upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${contentType}\r\nContent-Length: ${payload.length}\r\n\r\n`,
      );
      socket.write(payload);
    }
    await complete;
    return [...received.matchAll(responses)].map(([, status, body]) => ({
      status: Number(status),
      body: JSON.parse(body!) as unknown,
    }));
  } finally {
    socket.destroy();
  }
}

it('drains a large upload rejected by the parser so its connection stays usable', async () => {
  // Larger than loopback socket buffers: the parser rejects the first header
  // while most of the body has not yet been read from the connection.
  const invalidAudio = Buffer.alloc(16 * 1024 * 1024);
  const [rejected, accepted] = await sendPipelined([
    multipartBody(invalidAudio),
    multipartBody(frame()),
  ]);
  expect(rejected).toMatchObject({ status: 422, body: { error: 'invalid-mp3' } });
  expect(accepted).toEqual({ status: 200, body: { frameCount: 1 } });
});

it('keeps serving when a form ends unterminated while its rejected upload drains', async () => {
  const { contentType, payload } = multipartBody(Buffer.alloc(16 * 1024 * 1024));
  const withoutClosingBoundary = payload.subarray(0, payload.lastIndexOf('\r\n--'));
  const [rejected, accepted] = await sendPipelined([
    { contentType, payload: withoutClosingBoundary },
    multipartBody(frame()),
  ]);
  expect(rejected).toMatchObject({ status: 422, body: { error: 'invalid-mp3' } });
  expect(accepted).toEqual({ status: 200, body: { frameCount: 1 } });
});

it('cleans up a cancelled upload and continues accepting requests', async () => {
  const cancellationApp = await buildApp();
  const started = Promise.withResolvers<IncomingMessage>();
  cancellationApp.addHook('onRequest', async (request) => {
    started.resolve(request.raw);
  });
  const address = await cancellationApp.listen({ host: '127.0.0.1', port: 0 });
  const { contentType, payload } = multipartBody(frame());
  const client = httpRequest(`${address}/file-upload`, {
    method: 'POST',
    headers: { 'content-type': contentType },
  });
  // Cancellation can raise a local socket error; it is expected and observed.
  client.on('error', () => {});
  try {
    client.write(payload.subarray(0, payload.length - 64));
    const serverRequest = await started.promise;
    const closed = new Promise<void>((resolve) => serverRequest.once('close', resolve));
    client.destroy();
    await closed;
    expect(serverRequest.aborted).toBe(true);

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(frame())], { type: 'audio/mpeg' }), 'next.mp3');
    const response = await fetch(`${address}/file-upload`, { method: 'POST', body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ frameCount: 1 });
  } finally {
    client.destroy();
    await cancellationApp.close();
  }
});
