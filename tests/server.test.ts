import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';

function startServer(port: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: port, NODE_ENV: 'production' },
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
  return { child, started: started.promise, exited: exited.promise, errorOutput: () => stderr };
}

it('rejects invalid PORT configuration before opening a listener', async () => {
  const server = startServer('not-a-port');
  const result = await server.exited;
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(server.errorOutput()).toContain('PORT must be an integer between 1 and 65535');
});

// Windows process.kill(SIGTERM) terminates a process without delivering a catchable signal.
it.skipIf(process.platform === 'win32')('exits cleanly after SIGTERM', async () => {
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
  const server = startServer(String(address.port));
  try {
    await server.started;
    expect(server.child.kill('SIGTERM')).toBe(true);
    expect(await server.exited).toEqual({ code: 0, signal: null });
  } finally {
    server.child.kill('SIGKILL');
    await server.exited;
  }
});
