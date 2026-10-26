import { expect, it } from 'vitest';
import { createUploadWork } from '../src/upload-work.js';

it('waits for nested cleanup registered while a failed operation unwinds', async () => {
  const work = createUploadWork();
  const key = {};
  const first = Promise.withResolvers<void>();
  const drain = Promise.withResolvers<void>();
  const primary = new Error('primary');
  const operation = first.promise.finally(() => {
    void work.track(key, drain.promise);
  });
  expect(work.track(key, operation)).toBe(operation);
  let idle = false;
  const completion = work.waitForIdle(key).then(() => {
    idle = true;
  });
  first.reject(primary);
  await expect(operation).rejects.toBe(primary);
  await Promise.resolve();
  expect(idle).toBe(false);
  drain.reject(new Error('discarded remainder'));
  await completion;
  expect(idle).toBe(true);
  await expect(work.waitForIdle(key)).resolves.toBeUndefined();
});

it('isolates requests, observes rejection immediately and can reuse an idle key', async () => {
  const work = createUploadWork();
  const first = {};
  const second = {};
  const waiting = Promise.withResolvers<number>();
  void work.track(first, waiting.promise);
  void work.track(first, Promise.resolve(2));
  await work.waitForIdle(second);
  waiting.resolve(1);
  await work.waitForIdle(first);
  void work.track(first, Promise.reject(new Error('observed')));
  await work.waitForIdle(first);
});

it('tracking the same promise twice cannot delete newly registered cleanup state', async () => {
  const work = createUploadWork();
  const request = {};
  const original = Promise.withResolvers<void>();
  const drain = Promise.withResolvers<void>();
  void work.track(request, original.promise);
  void original.promise.then(() => {
    void work.track(request, drain.promise);
  });
  void work.track(request, original.promise);
  original.resolve();
  await original.promise;
  let idle = false;
  const completion = work.waitForIdle(request).then(() => {
    idle = true;
  });
  await Promise.resolve();
  expect(idle).toBe(false);
  drain.resolve();
  await completion;
  expect(idle).toBe(true);
});
