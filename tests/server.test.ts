import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { frame, mp3, multipartBody } from './helpers/mp3-fixtures.js';
import { expect, it } from 'vitest';

function startServer(port: string, maxUploadBytes?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: port,
    NODE_ENV: 'production',
  };
  // Test the absent default independently of the invoking shell's configuration.
  delete env['MAX_UPLOAD_BYTES'];
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
it.skipIf(process.platform === 'win32')('exits cleanly after SIGTERM', async () => {
  const server = startServer(await availablePort());
  try {
    await server.started;
    expect(server.child.kill('SIGTERM')).toBe(true);
    expect(await server.exited).toEqual({ code: 0, signal: null });
  } finally {
    server.child.kill('SIGKILL');
    await server.exited;
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
