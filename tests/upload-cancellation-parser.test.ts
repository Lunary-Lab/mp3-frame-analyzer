import type { FastifyInstance } from 'fastify';
import type * as Timers from 'node:timers/promises';
import type * as Parser from '../src/mp3/count-frames.js';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { frame, multipartBody } from './helpers/mp3-fixtures.js';
import { openUpload } from './helpers/upload-socket.js';

const scheduling = vi.hoisted(() => ({
  entered: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
}));
vi.mock('node:timers/promises', async (original) => {
  const timers = await original<typeof Timers>();
  return {
    ...timers,
    setImmediate: async () => {
      // Hold one real cooperative scheduling boundary, not a fabricated parser result.
      scheduling.entered?.();
      await scheduling.resume;
      await timers.setImmediate();
    },
  };
});
vi.mock('../src/mp3/count-frames.js', async (original) => {
  const parser = await original<typeof Parser>();
  return { ...parser, countMp3Frames: vi.fn(parser.countMp3Frames) };
});
const count = vi.mocked(countMp3Frames);
const apps: FastifyInstance[] = [];
let release: (() => void) | undefined;
afterEach(async () => {
  release?.();
  release = undefined;
  scheduling.entered = undefined;
  scheduling.resume = undefined;
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
  count.mockClear();
});

function denseAncillary(): Buffer {
  const bytes = Buffer.alloc(2700);
  for (let start = 0; start < bytes.length; start += 900) {
    bytes.set([255, 251, 4, 192], start);
    for (let offset = 21; offset + 4 <= 900; offset += 3) {
      bytes.set([255, 251, 0, 192], start + offset);
    }
  }
  return bytes;
}

it.each(
  ['raw', 'multipart'].flatMap((form) => [
    {
      form,
      work: 'traversal',
      fixture: () => Buffer.concat(Array.from({ length: 1024 }, () => frame())),
      frameCount: 1024,
    },
    { form, work: 'inference', fixture: denseAncillary, frameCount: 3 },
  ]),
)(
  'stops the actual buffered $form parser when its peer disconnects at a $work yield',
  async ({ form, fixture, frameCount }) => {
    const app = await buildApp({ maxActiveUploads: 1 });
    apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    scheduling.entered = entered.resolve;
    scheduling.resume = resume.promise;
    release = resume.resolve;
    const bytes = fixture();
    const body = multipartBody(bytes);
    const payload = form === 'raw' ? bytes : body.payload;
    const sender = openUpload(
      address,
      form === 'raw' ? 'audio/mpeg' : body.contentType,
      payload.length,
    );
    sender.client.end(payload);
    await entered.promise;
    const signal = count.mock.lastCall?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    const aborted = new Promise<void>((resolve) =>
      signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    // Observe the original parser rejection before letting it unwind.
    const stopped = expect(count.mock.results.at(-1)?.value).rejects.toMatchObject({
      name: 'AbortError',
    });
    sender.client.destroy();
    await aborted;
    resume.resolve();
    await stopped;
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
    const intact = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': 'audio/mpeg' },
      payload: bytes,
    });
    expect(intact.statusCode).toBe(200);
    expect(intact.json()).toEqual({ frameCount });
  },
);
