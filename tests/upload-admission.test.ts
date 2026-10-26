import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { frame, multipartBody } from './helpers/mp3-fixtures.js';
import { openUpload } from './helpers/upload-socket.js';
import { maxActiveUploadsFromEnvironment } from '../src/server-config.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
});
async function server(maxActiveUploads = 1) {
  const app = await buildApp({ maxActiveUploads });
  apps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address };
}
const probe = (app: FastifyInstance) =>
  app.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': 'audio/mpeg' },
    payload: frame(),
  });
async function recover(app: FastifyInstance) {
  await expect.poll(async () => (await probe(app)).statusCode).toBe(200);
}

it.each(['raw', 'multipart'])(
  'rejects overload before an unfinished %s body and recovers after abort',
  async (form) => {
    const app = await buildApp({ maxActiveUploads: 1 });
    apps.push(app);
    const seen = Promise.withResolvers<void>();
    app.addHook('onRequest', (_request, _reply, done) => {
      seen.resolve();
      done();
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const hold = openUpload(address, 'audio/mpeg', 417);
    hold.client.write(frame().subarray(0, 4));
    await seen.promise;
    const multipart = multipartBody(frame());
    const reject = openUpload(
      address,
      form === 'raw' ? 'audio/mpeg' : multipart.contentType,
      100_000_000,
    );
    reject.client.flushHeaders();
    expect(await reject.response).toEqual({
      status: 503,
      connection: 'close',
      body: {
        error: 'server-busy',
        message: 'Upload capacity is temporarily exhausted',
      },
    });
    await reject.closed;
    for (let i = 0; i < 3; i++) {
      const response = await probe(app);
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
    }
    hold.client.destroy();
    await hold.closed;
    await recover(app);
  },
);

it('returns its slot after successful raw and multipart requests and every early error', async () => {
  const { app } = await server();
  for (const payload of [frame(), Buffer.from('not mp3'), Buffer.alloc(0)]) {
    await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': 'audio/mpeg' },
      payload,
    });
    await recover(app);
  }
  const form = multipartBody(frame());
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/file-upload',
        headers: { 'content-type': form.contentType },
        payload: form.payload,
      })
    ).statusCode,
  ).toBe(200);
  for (const [url, contentType] of [
    ['/file-upload?includeVbrHeaderFrame=no', 'audio/mpeg'],
    ['/file-upload', 'x/bad'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': contentType },
      payload: frame(),
    });
    await recover(app);
  }
});

it('releases a stalled upload after the transport timeout', async () => {
  const { app, address } = await server();
  app.server.setTimeout(100);
  const hold = openUpload(address, 'audio/mpeg', 417);
  hold.client.write(frame().subarray(0, 4));
  await hold.closed;
  await expect(hold.response).rejects.toThrow();
  await recover(app);
});

it('shuts down while uploads are active without retaining their work after abort', async () => {
  const { app, address } = await server(2);
  const hold = openUpload(address, 'audio/mpeg', 417);
  hold.client.write(frame().subarray(0, 4));
  await expect.poll(async () => (await probe(app)).statusCode).toBe(200);
  const closed = app.close();
  hold.client.destroy();
  await closed;
  expect(app.server.listening).toBe(false);
});

it('validates deployment and app admission limits without coercions or unlimited mode', async () => {
  expect(maxActiveUploadsFromEnvironment(undefined)).toBe(8);
  for (const value of ['1', '8', '1024', '0002'])
    expect(maxActiveUploadsFromEnvironment(value)).toBe(Number(value));
  for (const value of [
    '',
    '0',
    '-1',
    '+1',
    '1.5',
    ' 1',
    '1e2',
    'Infinity',
    '1025',
    '9'.repeat(400),
  ]) {
    expect(() => maxActiveUploadsFromEnvironment(value)).toThrow('MAX_ACTIVE_UPLOADS');
  }
  for (const maximum of [0, -1, 0.5, 1025, Infinity, NaN]) {
    await expect(buildApp({ maxActiveUploads: maximum })).rejects.toThrow('maxActiveUploads');
  }
});

it('releases exactly one slot while another admitted upload remains active', async () => {
  const app = await buildApp({ maxActiveUploads: 2 });
  apps.push(app);
  let requests = 0;
  app.addHook('preHandler', (_request, _reply, done) => {
    requests++;
    done();
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const holds = [openUpload(address, 'audio/mpeg', 417), openUpload(address, 'audio/mpeg', 417)];
  for (const hold of holds) hold.client.write(frame().subarray(0, 4));
  await expect.poll(() => requests).toBe(2);
  expect((await probe(app)).statusCode).toBe(503);
  holds[0]!.client.end(frame().subarray(4));
  expect((await holds[0]!.response).status).toBe(200);
  await recover(app);
  holds[1]!.client.destroy();
  await holds[1]!.closed;
  await recover(app);
});

it('closes unconsumed multipart bodies when protocol or pre-handler failures respond before reading', async () => {
  const { app, address } = await server();
  for (let i = 0; i < 3; i++) {
    const result = await fetch(address + '/file-upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'no boundary',
    });
    expect(result.status).toBe(400);
    expect(result.headers.get('connection')).toBe('close');
    await result.arrayBuffer();
    await recover(app);
  }
  const failing = await buildApp({ maxActiveUploads: 1 });
  apps.push(failing);
  failing.addHook('preHandler', async () => {
    throw new Error('private error');
  });
  const form = multipartBody(frame());
  const response = await failing.inject({
    method: 'POST',
    url: '/file-upload',
    headers: { 'content-type': form.contentType },
    payload: form.payload,
  });
  expect(response.statusCode).toBe(500);
  expect(response.headers.connection).toBe('close');
  await failing.close();
});

it('closes a body partially read by a failing hook before the upload consumer starts', async () => {
  const app = await buildApp({ maxActiveUploads: 1 });
  apps.push(app);
  app.addHook('preHandler', async (request) => {
    let byte: unknown = request.raw.read(1);
    if (byte === null) {
      await once(request.raw, 'readable');
      byte = request.raw.read(1);
    }
    expect(byte).not.toBeNull();
    expect(request.raw.readableDidRead).toBe(true);
    throw new Error('private partially-read hook failure');
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const form = multipartBody(frame());
  const response = await fetch(address + '/file-upload', {
    method: 'POST',
    headers: { 'content-type': form.contentType },
    body: new Uint8Array(form.payload),
  });
  expect(response.status).toBe(500);
  expect(response.headers.get('connection')).toBe('close');
  await response.arrayBuffer();
  await app.close();
});
