import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { closeWithDeadline } from '../src/shutdown.js';

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
