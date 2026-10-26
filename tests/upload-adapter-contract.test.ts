import { Readable } from 'node:stream';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart, { type FastifyMultipartBaseOptions } from '@fastify/multipart';
import { expect, it, vi } from 'vitest';
import { registerUploads, type UploadConsumer } from '../src/upload.js';

// Defensive adapter contracts intentionally use dependency-level inputs the
// pinned framework normally rejects earlier. Real HTTP classification remains
// covered separately; these tests do not claim these inputs bypass Fastify.
async function adapter() {
  const app = Fastify();
  const registration = vi.spyOn(app, 'register');
  const uploads = await registerUploads(app, { maxUploadBytes: 1024 });
  const options = registration.mock.calls.find(([plugin]) => plugin === multipart)?.[1];
  expect(options).toBeDefined();
  return { app, uploads, options: options as FastifyMultipartBaseOptions };
}

function rawContext(body: unknown, contentType?: string) {
  const raw = new Readable({ read() {} });
  const header = vi.fn();
  const request = {
    raw,
    body,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    isMultipart: () => false,
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;
  const reply = { header } as unknown as FastifyReply;
  return { request, reply, header, raw };
}

it('does not classify a filename-free untyped part as a file or trust its field name', async () => {
  const { app, options } = await adapter();
  try {
    const classify = options.isPartAFile!;
    expect(classify('file', undefined, undefined)).toBe(false);
    expect(classify(undefined, undefined, undefined)).toBe(false);
    expect(classify('file', 'text/plain', undefined)).toBe(false);
    expect(classify('other', 'Audio/MPEG', undefined)).toBe(true);
    expect(classify('file', undefined, '')).toBe(true);
  } finally {
    await app.close();
  }
});

it.each([undefined, 'text/plain'])(
  'rejects a handed-over stream with unaccepted Content-Type %j without reading it',
  async (contentType) => {
    const { app, uploads } = await adapter();
    const stream = Readable.from([Buffer.from([1])]);
    const iterator = vi.spyOn(stream, 'iterator');
    const ctx = rawContext(stream, contentType);
    const consume = vi.fn<UploadConsumer<number>>();
    try {
      await expect(uploads.consume(ctx.request, ctx.reply, consume)).rejects.toMatchObject({
        status: 415,
        code: 'unsupported-media-type',
        message: 'Expected an MP3 upload',
      });
      expect(consume).not.toHaveBeenCalled();
      expect(iterator).not.toHaveBeenCalled();
      expect(ctx.header).toHaveBeenCalledExactlyOnceWith('connection', 'close');
    } finally {
      stream.destroy();
      ctx.raw.destroy();
      await app.close();
    }
  },
);

it.each([undefined, Buffer.from([1])])(
  'rejects a non-stream raw body before consumption',
  async (body) => {
    const { app, uploads } = await adapter();
    const ctx = rawContext(body, 'audio/mpeg');
    const consume = vi.fn<UploadConsumer<number>>();
    try {
      await expect(uploads.consume(ctx.request, ctx.reply, consume)).rejects.toMatchObject({
        status: 400,
        code: 'empty-file',
        message: 'The MP3 file must not be empty',
      });
      expect(consume).not.toHaveBeenCalled();
      expect(ctx.header).toHaveBeenCalledExactlyOnceWith('connection', 'close');
    } finally {
      ctx.raw.destroy();
      await app.close();
    }
  },
);

it('never passes non-byte stream chunks to the consumer', async () => {
  const { app, uploads } = await adapter();
  const stream = Readable.from(['not byte data'], { objectMode: true });
  const ctx = rawContext(stream, 'audio/mpeg');
  const received: Uint8Array[] = [];
  try {
    await expect(
      uploads.consume(ctx.request, ctx.reply, async (upload) => {
        for await (const chunk of upload) received.push(chunk);
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid-upload',
      message: 'Invalid raw byte chunk',
    });
    expect(received).toEqual([]);
    expect(ctx.header).toHaveBeenCalledExactlyOnceWith('connection', 'close');
  } finally {
    stream.destroy();
    ctx.raw.destroy();
    await app.close();
  }
});

it('rejects a non-file part if a multipart provider yields one despite the configured field limit', async () => {
  const { app, uploads, options } = await adapter();
  const ctx = rawContext(undefined);
  ctx.request.isMultipart = () => true;
  ctx.request.parts = async function* () {
    yield {
      type: 'field',
      value: 'text',
      fieldname: 'file',
      mimetype: 'text/plain',
      encoding: '7bit',
      fieldnameTruncated: false,
      valueTruncated: false,
      fields: {},
    };
  };
  const consume = vi.fn<UploadConsumer<number>>();
  try {
    expect(options.limits?.fields).toBe(0);
    await expect(uploads.consume(ctx.request, ctx.reply, consume)).rejects.toMatchObject({
      status: 400,
      code: 'invalid-upload',
      message: 'Only one file field is accepted',
    });
    expect(consume).not.toHaveBeenCalled();
  } finally {
    ctx.raw.destroy();
    await app.close();
  }
});
