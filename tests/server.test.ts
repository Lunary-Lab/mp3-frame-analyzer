import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { frame, mp3, multipartBody } from './helpers/mp3-fixtures.js';
import { openUpload } from './helpers/upload-socket.js';
import { expect, it } from 'vitest';

function startServer(
  port: string,
  maxUploadBytes?: string,
  maxMultipartBytes?: string,
  maxActiveUploads?: string,
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: port,
    NODE_ENV: 'production',
  };
  // Test the absent default independently of the invoking shell's configuration.
  delete env['MAX_UPLOAD_BYTES'];
  delete env['MAX_MULTIPART_BYTES'];
  delete env['MAX_ACTIVE_UPLOADS'];
  if (maxActiveUploads !== undefined) env['MAX_ACTIVE_UPLOADS'] = maxActiveUploads;
  if (maxMultipartBytes !== undefined) env['MAX_MULTIPART_BYTES'] = maxMultipartBytes;
  if (maxUploadBytes !== undefined) env['MAX_UPLOAD_BYTES'] = maxUploadBytes;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const started = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const deadline = setTimeout(() => {
    started.reject(new Error('Server did not become ready within 5 seconds'));
    child.kill('SIGKILL');
  }, 5_000);
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('Server listening at')) {
      clearTimeout(deadline);
      started.resolve();
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.once('error', (error) => {
    clearTimeout(deadline);
    started.reject(error);
    exited.reject(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(deadline);
    started.reject(new Error(`Server exited before readiness: ${stderr}`));
    exited.resolve({ code, signal });
  });
  // Invalid startup is tested below; observe this promise to avoid unhandled rejection.
  void started.promise.catch(() => {});
  return {
    child,
    started: started.promise,
    exited: exited.promise,
    errorOutput: () => stderr,
    output: () => stdout,
  };
}

it('rejects invalid PORT configuration before opening a listener', async () => {
  const server = startServer('not-a-port');
  const result = await server.exited;
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(server.errorOutput()).toContain('PORT must be an integer between 1 and 65535');
});

async function availablePort(): Promise<string> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP address');
  }
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  return String(address.port);
}

// Windows process.kill(SIGTERM) terminates a process without delivering a catchable signal.
it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
  'exits cleanly after %s',
  async (signal) => {
    const server = startServer(await availablePort());
    try {
      await server.started;
      expect(server.child.kill(signal)).toBe(true);
      expect(await server.exited).toEqual({ code: 0, signal: null });
    } finally {
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

it('reports a real bind failure and exits without leaving the server process running', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const address = occupied.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  const server = startServer(String(address.port));
  try {
    await expect(server.started).rejects.toThrow('Server exited before readiness');
    expect(await server.exited).toEqual({ code: 1, signal: null });
    expect(server.output()).toContain('Server startup failed');
    const event: unknown = JSON.parse(server.output().trim());
    expect(event).toMatchObject({
      level: 50,
      msg: 'Server startup failed',
      err: { type: 'Error', message: 'Details omitted', stack: '' },
    });
    expect(server.output()).not.toContain('EADDRINUSE');
    expect(server.output()).not.toContain('Server listening at');
  } finally {
    server.child.kill('SIGKILL');
    await server.exited;
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it.each(['', 'invalid', '0', '-1', '1.5', '9007199254740992'])(
  'rejects invalid MAX_UPLOAD_BYTES %j before listening',
  async (value) => {
    const server = startServer(await availablePort(), value);
    try {
      await expect(server.started).rejects.toThrow('Server exited before readiness');
      expect(await server.exited).toEqual({ code: 1, signal: null });
      expect(server.errorOutput()).toContain(
        'MAX_UPLOAD_BYTES must be a positive safe integer in decimal bytes',
      );
      expect(server.output()).not.toContain('Server listening at');
    } finally {
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

function rawRequest(endpoint: string, bytes: Buffer, declaredSize?: number) {
  return new Promise<{ status: number | undefined; body: unknown; connection: string | undefined }>(
    (resolve, reject) => {
      const request = httpRequest(
        endpoint + '/file-upload',
        {
          method: 'POST',
          headers: {
            'content-type': 'audio/mpeg',
            ...(declaredSize === undefined ? {} : { 'content-length': String(declaredSize) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => {
            request.destroy();
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
              connection: response.headers.connection,
            });
          });
        },
      );
      request.once('error', reject);
      request.setTimeout(4000, () => request.destroy(new Error('Upload response timed out')));
      request.write(bytes.subarray(0, 1));
      // Leave an oversized declared body unfinished: the server must reject
      // its length before consuming even an invalid byte or awaiting the rest.
      if (declaredSize === undefined) request.end(bytes.subarray(1));
    },
  );
}

it('applies MAX_UPLOAD_BYTES to raw, chunked and multipart file bytes at the exact boundary', async () => {
  const port = await availablePort();
  const server = startServer(port, '835');
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await server.started;
    for (const [paddingA, paddingB, expectedStatus] of [
      [0, 0, 200], // 834 bytes: one below the configured limit.
      [0, 1, 200], // 835 bytes: exactly the configured limit.
      [1, 1, 413], // 836 bytes: one above the configured limit.
    ] as const) {
      const bytes = mp3([frame({ padding: paddingA }), frame({ padding: paddingB })]);
      const expectedBody =
        expectedStatus === 200
          ? { frameCount: 2 }
          : { error: 'file-too-large', message: 'File exceeds configured upload limit' };
      for (const { payload, contentType } of [
        { payload: bytes, contentType: 'audio/mpeg' },
        multipartBody(bytes),
      ]) {
        // fetch sends Content-Length; multipart envelope bytes do not count.
        const response = await fetch(endpoint + '/file-upload', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: new Uint8Array(payload),
        });
        expect(response.status, `${contentType}, ${bytes.length} bytes`).toBe(expectedStatus);
        expect(await response.json()).toEqual(expectedBody);
      }
      // Multiple writes without Content-Length exercise actual chunked transfer.
      const chunked = await rawRequest(endpoint, bytes);
      expect(chunked.status, `chunked, ${bytes.length} bytes`).toBe(expectedStatus);
      expect(chunked.body).toEqual(expectedBody);
    }
    const declared = await rawRequest(endpoint, Buffer.from([0]), 836);
    expect(declared).toEqual({
      status: 413,
      body: { error: 'file-too-large', message: 'File exceeds configured upload limit' },
      connection: 'close',
    });
    // A rejected request must not take the configured server down.
    expect((await rawRequest(endpoint, frame())).status).toBe(200);
  } finally {
    server.child.kill('SIGTERM');
    await server.exited;
  }
});

it('starts normally without MAX_UPLOAD_BYTES and accepts an upload', async () => {
  const port = await availablePort();
  const server = startServer(port);
  try {
    await server.started;
    expect(await rawRequest(`http://127.0.0.1:${port}`, frame())).toMatchObject({
      status: 200,
      body: { frameCount: 1 },
    });
  } finally {
    server.child.kill('SIGTERM');
    await server.exited;
  }
});

it.each(['', '0', '1e3', '9007199254740992'])(
  'rejects invalid MAX_MULTIPART_BYTES %j before listening',
  async (value) => {
    const server = startServer(await availablePort(), '1024', value);
    try {
      await expect(server.started).rejects.toThrow('Server exited before readiness');
      expect(await server.exited).toEqual({ code: 1, signal: null });
      expect(server.errorOutput()).toContain('MAX_MULTIPART_BYTES must be a positive safe integer');
      expect(server.output()).not.toContain('Server listening at');
    } finally {
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

it('applies the independent multipart environment budget while preserving raw file limits', async () => {
  const port = await availablePort();
  const form = multipartBody(frame());
  const server = startServer(port, '1024', String(form.payload.length));
  try {
    await server.started;
    for (const extra of [0, 1]) {
      const response = await fetch(`http://127.0.0.1:${port}/file-upload`, {
        method: 'POST',
        headers: { 'content-type': form.contentType },
        body: new Uint8Array(Buffer.concat([form.payload, Buffer.alloc(extra, 0x20)])),
      });
      expect(response.status).toBe(extra === 0 ? 200 : 413);
      expect(await response.json()).toEqual(
        extra === 0
          ? { frameCount: 1 }
          : {
              error: 'request-too-large',
              message: 'Multipart body exceeds configured upload limit',
            },
      );
    }
    expect(await rawRequest(`http://127.0.0.1:${port}`, mp3([frame(), frame()]))).toMatchObject({
      status: 200,
      body: { frameCount: 2 },
    });
  } finally {
    server.child.kill('SIGTERM');
    await server.exited;
  }
});

function heldKeepAliveUpload(
  port: string,
  form: 'raw' | 'multipart',
  bytes = frame(),
  holdFile = false,
) {
  const socket = connect(Number(port), '127.0.0.1');
  const multipart = multipartBody(bytes);
  const tail = multipart.payload.lastIndexOf('\r\n--');
  const prefix =
    form === 'raw' ? bytes : multipart.payload.subarray(0, tail - (holdFile ? bytes.length : 0));
  const suffix = form === 'raw' ? Buffer.alloc(0) : multipart.payload.subarray(tail);
  const contentType = form === 'raw' ? 'audio/mpeg' : multipart.contentType;
  let received = '';
  let error: Error | undefined;
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
  });
  socket.on('error', (failure) => {
    error = failure;
  });
  const chunk = (payload: Buffer) => {
    socket.write(`${payload.length.toString(16)}\r\n`);
    socket.write(payload);
    socket.write('\r\n');
  };
  socket.write(
    `POST /file-upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: ${contentType}\r\nTransfer-Encoding: chunked\r\n\r\n`,
  );
  chunk(prefix);
  return {
    socket,
    chunk,
    sendFile() {
      chunk(bytes);
    },
    finish() {
      if (suffix.length > 0) chunk(suffix);
      socket.write('0\r\n\r\n');
    },
    async response(count = 1, status = 200, body: unknown = { frameCount: 1 }) {
      const responses = () => [...received.matchAll(/HTTP\/1\.1 (\d{3})[^]*?\r\n\r\n(\{[^}]*\})/g)];
      await expect
        .poll(
          () => {
            if (error !== undefined) throw error;
            return responses().length;
          },
          { timeout: 2000 },
        )
        .toBe(count);
      expect(received.match(/HTTP\/1\.1 \d{3}/g)).toEqual(Array(count).fill(`HTTP/1.1 ${status}`));
      expect(
        responses().map((match) => ({
          status: Number(match[1]),
          body: JSON.parse(match[2]!) as unknown,
        })),
      ).toEqual(Array.from({ length: count }, () => ({ status, body })));
      return received;
    },
  };
}

async function stopAccepting(port: string): Promise<void> {
  // Public listener closure proves shutdown has started before the held bodies
  // finish. Merely sending a signal or sleeping could let the broken path pass.
  await expect
    .poll(
      () =>
        new Promise<boolean>((resolve, reject) => {
          const probe = connect(Number(port), '127.0.0.1');
          probe.once('connect', () => {
            probe.destroy();
            resolve(true);
          });
          probe.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNREFUSED') resolve(false);
            else reject(error);
          });
        }),
      { timeout: 2000 },
    )
    .toBe(false);
}

it.skipIf(process.platform === 'win32')(
  'drains multiple accepted keep-alive uploads after SIGTERM without closing active work',
  async () => {
    const port = await availablePort();
    const server = startServer(port);
    const uploads: ReturnType<typeof heldKeepAliveUpload>[] = [];
    try {
      await server.started;
      uploads.push(heldKeepAliveUpload(port, 'raw'), heldKeepAliveUpload(port, 'multipart'));
      await expect
        .poll(() => server.output().match(/"msg":"incoming request"/g)?.length ?? 0)
        .toBe(2);
      expect(server.child.kill('SIGTERM')).toBe(true);
      await stopAccepting(port);
      uploads[0]!.finish();
      await uploads[0]!.response();
      expect(server.child.exitCode).toBeNull();
      expect(uploads[1]!.socket.destroyed).toBe(false);
      uploads[1]!.finish();
      await uploads[1]!.response();
      await expect.poll(() => server.child.exitCode, { timeout: 2000 }).toBe(0);
      expect(await server.exited).toEqual({ code: 0, signal: null });
      expect(server.output()).not.toContain('Server shutdown failed');
    } finally {
      for (const upload of uploads) upload.socket.destroy();
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'preserves ordinary keep-alive reuse before shutdown',
  async () => {
    const port = await availablePort();
    const server = startServer(port);
    let upload: ReturnType<typeof heldKeepAliveUpload> | undefined;
    try {
      await server.started;
      upload = heldKeepAliveUpload(port, 'multipart');
      upload.finish();
      expect((await upload.response()).toLowerCase()).toContain('connection: keep-alive');
      const audio = frame();
      upload.socket.write(
        `POST /file-upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: audio/mpeg\r\nContent-Length: ${audio.length}\r\n\r\n`,
      );
      upload.socket.write(audio);
      await upload.response(2);
      expect(upload.socket.destroyed).toBe(false);
      server.child.kill('SIGTERM');
      expect(await server.exited).toEqual({ code: 0, signal: null });
    } finally {
      upload?.socket.destroy();
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'still enforces the real shutdown deadline for an actively unfinished upload',
  async () => {
    const port = await availablePort();
    const server = startServer(port);
    let upload: ReturnType<typeof heldKeepAliveUpload> | undefined;
    let writer: ReturnType<typeof setInterval> | undefined;
    try {
      await server.started;
      upload = heldKeepAliveUpload(port, 'multipart');
      await expect.poll(() => server.output().includes('"msg":"incoming request"')).toBe(true);
      // Keep valid MPEG data arriving, so the idle transport timer cannot
      // masquerade as the shutdown deadline being exercised.
      writer = setInterval(() => upload!.chunk(frame()), 100);
      const started = performance.now();
      server.child.kill('SIGTERM');
      await stopAccepting(port);
      expect(await server.exited).toEqual({ code: 1, signal: null });
      expect(performance.now() - started).toBeGreaterThanOrEqual(9000);
      expect(server.output()).toContain('Server shutdown failed');
      expect(server.output()).toContain('"message":"Details omitted"');
    } finally {
      clearInterval(writer);
      upload?.socket.destroy();
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

it.skipIf(process.platform === 'win32').each(['before', 'during'] as const)(
  'finishes a delayed multipart body whose error response precedes EOF %s shutdown',
  async (when) => {
    const port = await availablePort();
    const server = startServer(port);
    let upload: ReturnType<typeof heldKeepAliveUpload> | undefined;
    const expectedError = {
      error: 'invalid-mp3',
      message: 'Invalid MPEG-1 Layer III frame header',
    };
    try {
      await server.started;
      // In the second ordering only multipart headers arrive before shutdown;
      // the invalid file and its early response are both delayed until after it.
      upload = heldKeepAliveUpload(port, 'multipart', Buffer.from('NOPE'), when === 'during');
      await expect.poll(() => server.output().includes('"msg":"incoming request"')).toBe(true);
      if (when === 'before') await upload.response(1, 422, expectedError);
      expect(server.child.kill('SIGTERM')).toBe(true);
      await stopAccepting(port);
      if (when === 'during') {
        upload.sendFile();
        await upload.response(1, 422, expectedError);
      }
      expect(server.child.exitCode).toBeNull();
      expect(upload.socket.destroyed).toBe(false);
      // The body terminator really arrives after the complete error response.
      upload.finish();
      await expect.poll(() => server.child.exitCode, { timeout: 2000 }).toBe(0);
      expect(await server.exited).toEqual({ code: 0, signal: null });
      expect(server.output()).not.toContain('Server shutdown failed');
    } finally {
      upload?.socket.destroy();
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

it.each(['', '0', '1025', 'invalid'])(
  'rejects invalid MAX_ACTIVE_UPLOADS %j before listening',
  async (value) => {
    const server = startServer(await availablePort(), undefined, undefined, value);
    await expect(server.started).rejects.toThrow('Server exited before readiness');
    expect(await server.exited).toEqual({ code: 1, signal: null });
    expect(server.errorOutput()).toContain(
      'MAX_ACTIVE_UPLOADS must be an integer between 1 and 1024',
    );
    expect(server.output()).not.toContain('Server listening at');
  },
);

it.skipIf(process.platform === 'win32')(
  'applies the configured admission cap and drains an active upload on SIGTERM',
  async () => {
    const port = await availablePort();
    const server = startServer(port, undefined, undefined, '1');
    let hold: ReturnType<typeof openUpload> | undefined;
    try {
      await server.started;
      const address = `http://127.0.0.1:${port}`;
      hold = openUpload(address, 'audio/mpeg', 417);
      hold.client.write(frame().subarray(0, 4));
      await expect
        .poll(async () => {
          const result = await fetch(address + '/file-upload', {
            method: 'POST',
            headers: { 'content-type': 'audio/mpeg' },
            body: new Uint8Array(frame()),
          });
          await result.arrayBuffer();
          return result.status;
        })
        .toBe(503);
      expect(server.child.kill('SIGTERM')).toBe(true);
      hold.client.end(frame().subarray(4));
      expect(await hold.response).toMatchObject({ status: 200, body: { frameCount: 1 } });
      expect(await server.exited).toEqual({ code: 0, signal: null });
    } finally {
      hold?.client.destroy();
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'serves tiny requests alongside bounded header-dense uploads without a latency SLA',
  async () => {
    // Same original control as sequence-scheduling: three 900-byte, 48 kHz,
    // 300-kbps free frames. The repeated 44.1 kHz markers are ancillary decoys;
    // their impossible side fields are independently checked in that suite.
    // Do not obtain either expected count from the production parser.
    const dense = Buffer.alloc(2_700);
    for (let start = 0; start < dense.length; start += 900) {
      dense.set([255, 251, 4, 192], start);
      for (let offset = 21; offset + 4 <= 900; offset += 3) {
        dense.set([255, 251, 0, 192], start + offset);
      }
    }
    const tiny = frame();
    const port = await availablePort();
    const server = startServer(port, '4096', undefined, '3');
    const active = new Set<ReturnType<typeof openUpload>>();
    let load: Promise<void[]> | undefined;
    let completedDense = 0;
    const denseRequests = 64;
    try {
      await server.started;
      const address = `http://127.0.0.1:${port}`;
      const send = async (bytes: Buffer, expectedFrames: number) => {
        const started = performance.now();
        const upload = openUpload(address, 'audio/mpeg', bytes.length);
        active.add(upload);
        try {
          // Complete every body immediately: overlap is not manufactured by
          // withholding EOF, holding a parser turn, or mocking its scheduler.
          upload.client.end(bytes);
          expect(await upload.response).toMatchObject({
            status: 200,
            body: { frameCount: expectedFrames },
          });
          return performance.now() - started;
        } finally {
          active.delete(upload);
          upload.client.destroy();
        }
      };
      // Two sequential workers bound in-flight dense requests and total input;
      // the third admission slot belongs to one sequential tiny probe worker.
      load = Promise.all(
        Array.from({ length: 2 }, async () => {
          for (let index = 0; index < denseRequests / 2; index++) {
            await send(dense, 3);
            completedDense++;
          }
        }),
      );
      void load.catch(() => {}); // Preserve failures if a probe rejects first.
      const tinyMs: number[] = [];
      let overlappingResponses = 0;
      for (let index = 0; index < 8; index++) {
        tinyMs.push(await send(tiny, 1));
        if (completedDense < denseRequests) overlappingResponses++;
      }
      // An unfinished batch proves concurrent request traffic, not that a tiny
      // response interrupted one active parse. Blocking per-request parsing can
      // also pass this smoke; deterministic parser-yield tests are separate.
      expect(overlappingResponses).toBeGreaterThan(0);
      await load;
      expect(completedDense).toBe(denseRequests);
      await send(tiny, 1); // All admission slots remain recoverable afterward.
      console.info(
        JSON.stringify({
          kind: 'bounded-header-dense-http',
          denseRequests,
          denseBytesEach: dense.length,
          maxConcurrentRequests: 3,
          tinyBytesEach: tiny.length,
          tinyMs,
          overlappingResponses,
          note: 'Two-second socket inactivity watchdog; timings are local samples, not an SLA.',
        }),
      );
      expect(server.child.kill('SIGTERM')).toBe(true);
      expect(await server.exited).toEqual({ code: 0, signal: null });
    } finally {
      for (const upload of active) upload.client.destroy();
      server.child.kill('SIGKILL');
      await Promise.allSettled([server.exited, ...(load === undefined ? [] : [load])]);
    }
  },
  10_000,
);

it.skipIf(process.platform === 'win32')(
  'serves a tiny request before a bounded maximum-indexed-frame-density upload completes',
  async () => {
    // 32 kbps / 48 kHz without padding is the smallest indexed span: 96 bytes.
    // Zero stereo side information occupies bytes 4..35; part2_3_length=0
    // leaves bytes 36..95 ancillary. Header-like payload cannot change sizing.
    const short = frame({ bitrateIndex: 1, sampleRateIndex: 1 });
    expect(short.length).toBe(96);
    for (let offset = 36; offset + 4 <= short.length; offset += 4) {
      short.set([255, 251, 4, 192], offset);
    }
    const frameCount = 65_536;
    const bytes = Buffer.alloc(frameCount * short.length);
    for (let offset = 0; offset < bytes.length; offset += short.length) bytes.set(short, offset);
    const port = await availablePort();
    const server = startServer(port, String(bytes.length), undefined, '2');
    const clients: ReturnType<typeof openUpload>[] = [];
    try {
      await server.started;
      const address = `http://127.0.0.1:${port}`;
      const tiny = frame();
      const largeUpload = openUpload(address, 'audio/mpeg', bytes.length);
      const tinyUpload = openUpload(address, 'audio/mpeg', tiny.length);
      clients.push(largeUpload, tinyUpload);
      const started = performance.now();
      const events: { event: string; elapsedMs: number }[] = [];
      const record = (event: string) =>
        events.push({ event, elapsedMs: performance.now() - started });
      // These finish events describe the client's write queue, not server receipt
      // or parse start. No production hook, scheduler mock or withheld EOF is used.
      largeUpload.client.once('finish', () => record('large-client-write-finish'));
      tinyUpload.client.once('finish', () => record('tiny-client-write-finish'));
      const replies = Promise.all(
        [largeUpload, tinyUpload].map(async (upload, index) => {
          const response = await upload.response;
          record(index === 0 ? 'large-response-complete' : 'tiny-response-complete');
          return response;
        }),
      );
      record('large-end-called');
      largeUpload.client.end(bytes);
      record('tiny-end-called');
      tinyUpload.client.end(tiny);
      const [largeResponse, tinyResponse] = await replies;
      console.info(
        JSON.stringify({
          kind: 'bounded-maximum-indexed-frame-density-http',
          frameCount,
          frameBytes: short.length,
          largeBytes: bytes.length,
          maxConcurrentRequests: 2,
          events,
          note: 'HTTP streaming responsiveness, not CPU isolation, free inference or a latency SLA.',
        }),
      );
      expect(largeResponse).toMatchObject({ status: 200, body: { frameCount } });
      expect(tinyResponse).toMatchObject({ status: 200, body: { frameCount: 1 } });
      expect(
        events.filter(({ event }) => event.endsWith('response-complete')).map(({ event }) => event),
      ).toEqual(['tiny-response-complete', 'large-response-complete']);
      const recovery = openUpload(address, 'audio/mpeg', tiny.length);
      clients.push(recovery);
      recovery.client.end(tiny);
      expect(await recovery.response).toMatchObject({ status: 200, body: { frameCount: 1 } });
      expect(server.child.kill('SIGTERM')).toBe(true);
      expect(await server.exited).toEqual({ code: 0, signal: null });
    } finally {
      for (const upload of clients) upload.client.destroy();
      server.child.kill('SIGKILL');
      await server.exited;
    }
  },
  10_000,
);
