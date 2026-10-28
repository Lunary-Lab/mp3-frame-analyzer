import { expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Agent, request, type IncomingMessage } from 'node:http';
import { closeIdleConnectionsAfterDrain, closeWithDeadline } from '../src/shutdown.js';
import { observeListenerCleanup } from './helpers/listener-cleanup.js';

function observeShutdownListeners(app: FastifyInstance) {
  const observed = new WeakMap<IncomingMessage, ReturnType<typeof observeListenerCleanup>>();
  const unrelated = () => {};
  app.addHook('onRequest', (request, _reply, done) => {
    request.raw.on('end', unrelated);
    request.raw.on('close', unrelated);
    observed.set(request.raw, observeListenerCleanup(request.raw, ['end', 'close']));
    done();
  });
  closeIdleConnectionsAfterDrain(app);
  app.addHook('onRequest', (request, _reply, done) => {
    observed.get(request.raw)!.capture();
    done();
  });
  return (raw: IncomingMessage) => {
    observed.get(raw)!.expectDetached();
    for (const event of ['end', 'close']) expect(raw.listeners(event)).toContain(unrelated);
  };
}

it('closes a real listening server and runs its close hooks', async () => {
  const app = Fastify();
  let hookRan = false;
  app.addHook('onClose', async () => {
    hookRan = true;
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await closeWithDeadline(app);
  expect(app.server.listening).toBe(false);
  expect(hookRan).toBe(true);
});

it('preserves a close-hook failure for the bootstrap to report', async () => {
  const app = Fastify();
  const failure = new Error('Close hook failed');
  app.addHook('onClose', async () => {
    throw failure;
  });
  await app.ready();
  await expect(closeWithDeadline(app)).rejects.toBe(failure);
});

it('bounds a stalled close hook and releases its deadline timer', async () => {
  const app = Fastify();
  const pending = Promise.withResolvers<void>();
  app.addHook('onClose', async () => pending.promise);
  await app.ready();
  try {
    await expect(closeWithDeadline(app, 25)).rejects.toThrow('Server shutdown exceeded 25 ms');
  } finally {
    pending.resolve();
    await app.close();
  }
});

it('closes a newly idle keep-alive connection only after its accepted response finishes', async () => {
  const app = Fastify();
  const expectDetached = observeShutdownListeners(app);
  const entered = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  let raw: IncomingMessage | undefined;
  app.addHook('preClose', async () => {
    closing.resolve();
  });
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  );
  app.post('/', async (request) => {
    raw = request.raw;
    entered.resolve();
    let bytes = 0;
    for await (const chunk of request.raw) bytes += (chunk as Buffer).length;
    return { bytes };
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const agent = new Agent({ keepAlive: true });
  const response = Promise.withResolvers<{ status: number | undefined; body: string }>();
  const client = request(
    address,
    { method: 'POST', agent, headers: { 'content-type': 'application/octet-stream' } },
    (incoming) => {
      let body = '';
      incoming.setEncoding('utf8').on('data', (chunk) => {
        body += chunk;
      });
      incoming.once('error', response.reject);
      incoming.once('end', () => response.resolve({ status: incoming.statusCode, body }));
    },
  );
  client.once('error', response.reject);
  void response.promise.catch(() => {});
  try {
    client.write('a');
    await entered.promise;
    const stopped = closeWithDeadline(app, 1000);
    await closing.promise;
    client.end('b');
    expect(await response.promise).toEqual({ status: 200, body: '{"bytes":2}' });
    await stopped;
    expectDetached(raw!);
  } finally {
    client.destroy();
    agent.destroy();
    app.server.closeAllConnections();
    await app.close();
  }
});

it('detaches after abort and does not reap idle connections outside shutdown', async () => {
  const app = Fastify();
  const expectDetached = observeShutdownListeners(app);
  const reap = vi.spyOn(app.server, 'closeIdleConnections');
  const received = Promise.withResolvers<IncomingMessage>();
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  );
  app.post('/', async (request) => {
    received.resolve(request.raw);
    let bytes = 0;
    try {
      for await (const chunk of request.raw) bytes += (chunk as Buffer).length;
    } catch {
      // This fixture deliberately interrupts the request; no response is possible.
    }
    return { bytes };
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = request(address, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
  });
  client.on('error', () => {});
  try {
    client.write('a');
    const raw = await received.promise;
    const closed = new Promise<void>((resolve) => raw.once('close', resolve));
    client.destroy();
    await closed;
    expect(raw.readableEnded).toBe(false);
    expectDetached(raw);
    expect(reap).not.toHaveBeenCalled();
  } finally {
    client.destroy();
    app.server.closeAllConnections();
    await app.close();
  }
});
