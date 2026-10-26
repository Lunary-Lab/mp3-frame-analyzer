import { Agent, request, type ClientRequest, type IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { frame } from './helpers/mp3-fixtures.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
});

function readResponse(client: ClientRequest) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: unknown }>(
    (resolve, reject) => {
      client.once('error', reject);
      client.setTimeout(1_000, () => client.destroy(new Error('Local response timed out')));
      client.once('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          }),
        );
      });
    },
  );
}

const rejectedRoutes = [
  {
    method: 'PUT',
    path: '/file-upload?unused=true',
    status: 405,
    body: { error: 'method-not-allowed', message: 'Use POST /file-upload' },
  },
  {
    method: 'POST',
    path: '/missing',
    status: 404,
    body: { error: 'not-found', message: 'Route not found' },
  },
];

it.each(
  rejectedRoutes.flatMap((route) =>
    ['audio/mpeg', 'multipart/form-data; boundary=unfinished', 'application/x-unknown'].flatMap(
      (contentType) => [false, true].map((knownLength) => ({ ...route, contentType, knownLength })),
    ),
  ),
)(
  'finishes $status before closing an incomplete $contentType body (known length: $knownLength)',
  async ({ method, path, status, body, contentType, knownLength }) => {
    const app = await buildApp({
      maxUploadBytes: 512,
      maxMultipartBytes: 1024,
      maxActiveUploads: 1,
    });
    apps.push(app);
    const seen = Promise.withResolvers<IncomingMessage>();
    app.addHook('onRequest', (request, _reply, done) => {
      seen.resolve(request.raw);
      done();
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const client = request(address + path, {
      method,
      agent,
      headers: {
        'content-type': contentType,
        ...(knownLength ? { 'content-length': '8192' } : {}),
      },
    });
    const response = readResponse(client);
    try {
      // One received byte, not an EOF or a complete multipart part. Routing must
      // reject without delegating the unbounded remainder to Node's auto-drain.
      client.write('x');
      const raw = await seen.promise;
      const received = await response;
      const bytesAtResponse = raw.socket.bytesRead;
      expect(raw.complete).toBe(false);
      expect(bytesAtResponse).toBeGreaterThan(0);
      // A bounded late send reproduces the old behavior without a load campaign.
      // An already-closed socket may reject this write; readResponse observes it.
      client.write(Buffer.alloc(4096));
      expect(received.status).toBe(status);
      expect(received.body).toEqual(body);
      expect(received.headers['content-type']).toContain('application/json');
      expect(received.headers['allow']).toBe(status === 405 ? 'POST' : undefined);
      expect(received.headers.connection).toBe('close');
      await expect.poll(() => raw.destroyed, { timeout: 500 }).toBe(true);
      expect(raw.socket.bytesRead).toBe(bytesAtResponse);
      const next = request(address + '/file-upload', {
        method: 'POST',
        agent,
        headers: { 'content-type': 'audio/mpeg' },
      });
      const accepted = readResponse(next);
      next.end(frame());
      expect(await accepted).toMatchObject({ status: 200, body: { frameCount: 1 } });
      expect(next.reusedSocket).toBe(false);
    } finally {
      client.destroy();
      agent.destroy();
    }
  },
);

it.each(
  rejectedRoutes.flatMap((route) =>
    ['absent', 'zero', 'complete'].map((body) => ({ ...route, requestBody: body })),
  ),
)(
  'keeps $requestBody request connections reusable after $status',
  async ({ method, path, status, body, requestBody }) => {
    const app = await buildApp();
    apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const client = request(address + path, {
      method: requestBody === 'absent' ? 'GET' : method,
      agent,
      headers:
        requestBody === 'absent'
          ? {}
          : {
              'content-type': 'text/plain',
              'content-length': requestBody === 'zero' ? '0' : '4',
            },
    });
    const response = readResponse(client);
    try {
      client.end(requestBody === 'complete' ? 'done' : undefined);
      expect(await response).toMatchObject({ status, body, headers: { connection: 'keep-alive' } });
      const next = request(address + '/file-upload', {
        method: 'POST',
        agent,
        headers: { 'content-type': 'audio/mpeg' },
      });
      const accepted = readResponse(next);
      next.end(frame());
      expect(await accepted).toMatchObject({ status: 200, body: { frameCount: 1 } });
      expect(next.reusedSocket).toBe(true);
    } finally {
      client.destroy();
      agent.destroy();
    }
  },
);
