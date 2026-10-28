import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { expect, it, vi } from 'vitest';
import { withMultipartBudget } from '../src/multipart-budget.js';
import { defaultMaxMultipartBytes, MAX_UPLOAD_BYTES } from '../src/upload.js';
import { observeListenerCleanup } from './helpers/listener-cleanup.js';

function context(raw: Readable) {
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableFinished: false,
    destroyed: false,
  });
  const header = vi.fn();
  return {
    request: { raw, headers: {} } as FastifyRequest,
    reply: { raw: response, header } as unknown as FastifyReply,
    response,
    header,
    cleanup: observeListenerCleanup(raw, ['data', 'resume', 'end', 'close']),
  };
}

it('derives a 64 KiB multipart allowance without overflowing safe integer configuration', () => {
  expect(defaultMaxMultipartBytes(MAX_UPLOAD_BYTES)).toBe(MAX_UPLOAD_BYTES + 65536);
  expect(defaultMaxMultipartBytes(1)).toBe(65537);
  expect(defaultMaxMultipartBytes(Number.MAX_SAFE_INTEGER - 65536)).toBe(Number.MAX_SAFE_INTEGER);
  expect(defaultMaxMultipartBytes(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(defaultMaxMultipartBytes(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
});

it('attaches paused, preserves downstream backpressure and delivers every byte exactly once', async () => {
  const bytes = Array.from({ length: 16 }, (_, index) => Buffer.alloc(64, index));
  const raw = Readable.from(bytes, { objectMode: false, highWaterMark: 64 });
  const ctx = context(raw);
  const held = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  const received: Buffer[] = [];
  const destination = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _, done) {
      received.push(chunk);
      if (received.length === 1) {
        release = done;
        held.resolve();
      } else done();
    },
  });
  const result = withMultipartBudget(ctx.request, ctx.reply, 1024, async () => {
    ctx.cleanup.capture();
    expect(raw.isPaused()).toBe(true);
    expect(received).toHaveLength(0);
    // This is the same supported pipe operation used by the pinned multipart plugin.
    raw.pipe(destination);
    await finished(destination, { cleanup: true });
    return 7;
  });
  await held.promise;
  await nextTurn();
  expect(raw.isPaused()).toBe(true);
  expect(received).toHaveLength(1);
  expect(raw.readableLength).toBeLessThanOrEqual(64);
  release!();
  expect(await result).toBe(7);
  expect(Buffer.concat(received)).toEqual(Buffer.concat(bytes));
  ctx.cleanup.expectDetached();
  expect(ctx.header).not.toHaveBeenCalled();
});

it.each(['original', 'renamed'])(
  'gates same-chunk parser success and cleans up %s listeners without removing unrelated ones',
  async (names) => {
    const raw = new Readable({ read() {} });
    const unrelated = () => {};
    for (const event of ['resume', 'end', 'close']) raw.on(event, unrelated);
    const destroy = vi.spyOn(raw, 'destroy');
    const ctx = context(raw);
    let installed: ReturnType<typeof ctx.cleanup.capture> | undefined;
    const result = withMultipartBudget(ctx.request, ctx.reply, 3, () => {
      installed = ctx.cleanup.capture();
      if (names === 'renamed') {
        // A private rename must neither hide a leaked listener nor identify unrelated ones.
        for (const listeners of installed.values()) {
          for (const listener of listeners)
            Object.defineProperty(listener, 'name', { value: 'unrelated' });
        }
      }
      const parsed = Promise.withResolvers<number>();
      raw.once('data', () => parsed.resolve(7));
      raw.resume();
      return parsed.promise;
    });
    raw.push(Buffer.alloc(4));
    await expect(result).rejects.toMatchObject({ code: 'request-too-large' });
    expect(ctx.header).toHaveBeenCalledExactlyOnceWith('connection', 'close');
    expect(destroy).not.toHaveBeenCalled();
    ctx.response.emit('finish');
    ctx.response.emit('close');
    await nextTurn();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(ctx.response.listenerCount('finish')).toBe(0);
    expect(ctx.response.listenerCount('close')).toBe(0);
    ctx.cleanup.expectDetached();
    for (const event of ['resume', 'end', 'close'])
      expect(raw.listeners(event)).toContain(unrelated);
    if (names === 'renamed') {
      const leaked = installed!.get('data')![0]! as (chunk: Buffer) => void;
      raw.on('data', leaked);
      try {
        expect(() => ctx.cleanup.expectDetached()).toThrow('Retained data listener');
      } finally {
        raw.off('data', leaked);
      }
    }
  },
);

it.each(['finished', 'destroyed', 'writing'] as const)(
  'closes immediately after an already %s response without replacing it',
  async (state) => {
    const raw = new Readable({ read() {} });
    const ctx = context(raw);
    const earlier = new Error('earlier consumer failure');
    const result = withMultipartBudget(ctx.request, ctx.reply, 3, async () => {
      ctx.cleanup.capture();
      raw.resume();
      throw earlier;
    });
    await expect(result).rejects.toBe(earlier);
    ctx.response.headersSent = true;
    if (state === 'finished') ctx.response.writableFinished = true;
    else if (state === 'destroyed') ctx.response.destroyed = true;
    raw.push(Buffer.alloc(4));
    await nextTurn();
    if (state === 'writing') {
      expect(raw.destroyed).toBe(false);
      ctx.response.emit('finish');
      await nextTurn();
    }
    expect(raw.destroyed).toBe(true);
    expect(ctx.header).not.toHaveBeenCalled();
    ctx.cleanup.expectDetached();
  },
);

it('does not accept an already resolved result if the same call observed overflow', async () => {
  const raw = new Readable({ read() {} });
  const ctx = context(raw);
  const result = withMultipartBudget(ctx.request, ctx.reply, 3, () => {
    ctx.cleanup.capture();
    raw.emit('data', Buffer.alloc(4));
    // A direct same-turn completion is already settled when Promise.race subscribes.
    return Promise.resolve(7);
  });
  await expect(result).rejects.toMatchObject({ code: 'request-too-large' });
  raw.emit('data', Buffer.alloc(4));
  expect(ctx.header).toHaveBeenCalledTimes(1);
  ctx.response.emit('close');
  await nextTurn();
  ctx.cleanup.expectDetached();
});

it('does not consume another chunk when downstream drain resumes after overflow before response finish', async () => {
  const raw = Readable.from([Buffer.alloc(4, 1), Buffer.alloc(4, 2)], {
    objectMode: false,
    highWaterMark: 4,
  });
  const received: Buffer[] = [];
  const held = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  const destination = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _, done) {
      received.push(chunk);
      release = done;
      held.resolve();
    },
  });
  const closed = new Promise<void>((resolve) => raw.once('close', resolve));
  const resumed = vi.fn();
  raw.on('resume', resumed);
  const ctx = context(raw);
  const result = withMultipartBudget(ctx.request, ctx.reply, 3, async () => {
    ctx.cleanup.capture();
    raw.pipe(destination);
    await closed;
    return 7;
  });
  try {
    await expect(result).rejects.toMatchObject({ code: 'request-too-large' });
    await held.promise;
    const beforeDrain = resumed.mock.calls.length;
    release!();
    await nextTurn();
    await nextTurn();
    expect(resumed.mock.calls.length).toBeGreaterThan(beforeDrain);
    expect(raw.isPaused()).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(Buffer.alloc(4, 1));
    raw.resume();
    await nextTurn();
    expect(received).toHaveLength(1);
    expect(raw.destroyed).toBe(false);
    ctx.response.emit('finish');
    await closed;
    ctx.cleanup.expectDetached();
  } finally {
    raw.destroy();
    destination.destroy();
  }
});
