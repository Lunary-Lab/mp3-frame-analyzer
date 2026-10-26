import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// These are bootstrap dependency contracts, not substitutes for the real-process
// tests in server.test.ts or the extracted production artifact smoke.
const dependencies = vi.hoisted(() => ({
  buildApp: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  listen: vi.fn<(...args: unknown[]) => Promise<string>>(),
  close: vi.fn<(...args: unknown[]) => Promise<void>>(),
  error: vi.fn(),
}));
vi.mock('../src/app.js', () => ({ buildApp: dependencies.buildApp }));
vi.mock('../src/shutdown.js', () => ({ closeWithDeadline: dependencies.close }));

const lifecycle = { once: vi.fn<typeof process.once>(), exit: vi.fn<typeof process.exit>() };
const app = { listen: dependencies.listen, log: { error: dependencies.error } };
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  for (const name of ['PORT', 'HOST', 'MAX_UPLOAD_BYTES', 'MAX_MULTIPART_BYTES']) {
    vi.stubEnv(name, undefined);
  }
  dependencies.buildApp.mockResolvedValue(app);
  dependencies.listen.mockResolvedValue('http://127.0.0.1:3000');
  dependencies.close.mockResolvedValue(undefined);
  vi.spyOn(process, 'once').mockImplementation(lifecycle.once.mockReturnValue(process));
  vi.spyOn(process, 'exit').mockImplementation(lifecycle.exit.mockReturnValue(undefined as never));
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function signal(name: 'SIGINT' | 'SIGTERM') {
  const registrations = lifecycle.once.mock.calls.filter(([event]) => event === name);
  expect(registrations).toHaveLength(1);
  registrations[0]![1](name);
}

it('uses the documented bind and upload defaults when environment values are absent', async () => {
  await import('../src/server.js');
  expect(dependencies.buildApp).toHaveBeenCalledExactlyOnceWith({
    maxUploadBytes: 50 * 1024 * 1024,
    maxMultipartBytes: 50 * 1024 * 1024 + 65536,
  });
  expect(dependencies.listen).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 3000 });
  expect(dependencies.close).not.toHaveBeenCalled();
});

it.each(['1', '65535'])(
  'passes explicit bind and independent byte limits at PORT=%s',
  async (port) => {
    vi.stubEnv('PORT', port);
    vi.stubEnv('HOST', '::1');
    vi.stubEnv('MAX_UPLOAD_BYTES', '1024');
    vi.stubEnv('MAX_MULTIPART_BYTES', '512');
    await import('../src/server.js');
    expect(dependencies.buildApp).toHaveBeenCalledExactlyOnceWith({
      maxUploadBytes: 1024,
      maxMultipartBytes: 512,
    });
    expect(dependencies.listen).toHaveBeenCalledExactlyOnceWith({
      host: '::1',
      port: Number(port),
    });
  },
);

it.each(['', 'not-a-port', '0', '-1', '1.5', '65536', 'Infinity'])(
  'rejects invalid PORT=%j before constructing an application or registering signals',
  async (port) => {
    vi.stubEnv('PORT', port);
    await expect(import('../src/server.js')).rejects.toThrow(
      'PORT must be an integer between 1 and 65535',
    );
    expect(dependencies.buildApp).not.toHaveBeenCalled();
    expect(lifecycle.once).not.toHaveBeenCalled();
    expect(dependencies.listen).not.toHaveBeenCalled();
  },
);

it('propagates application construction failure without attempting to listen or close', async () => {
  const failure = new Error('application initialization failed');
  dependencies.buildApp.mockRejectedValue(failure);
  await expect(import('../src/server.js')).rejects.toBe(failure);
  expect(dependencies.listen).not.toHaveBeenCalled();
  expect(dependencies.close).not.toHaveBeenCalled();
  expect(lifecycle.once).not.toHaveBeenCalled();
});

it.each(['SIGINT', 'SIGTERM'] as const)('shares one pending shutdown after %s', async (first) => {
  const closed = Promise.withResolvers<void>();
  dependencies.close.mockReturnValue(closed.promise);
  await import('../src/server.js');
  signal(first);
  signal(first === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
  expect(dependencies.close).toHaveBeenCalledExactlyOnceWith(app);
  closed.resolve();
  await closed.promise;
  expect(dependencies.error).not.toHaveBeenCalled();
  expect(lifecycle.exit).not.toHaveBeenCalled();
});

it('logs a listener failure, marks failure exit status, and awaits application cleanup', async () => {
  const failure = new Error('address already in use');
  dependencies.listen.mockRejectedValue(failure);
  await import('../src/server.js');
  expect(dependencies.error).toHaveBeenCalledExactlyOnceWith(
    { err: failure },
    'Server startup failed',
  );
  expect(process.exitCode).toBe(1);
  expect(dependencies.close).toHaveBeenCalledExactlyOnceWith(app);
  expect(lifecycle.exit).not.toHaveBeenCalled();
});

it('reports a failed shutdown and invokes the final nonzero exit rather than hanging', async () => {
  const failure = new Error('close deadline exhausted');
  dependencies.close.mockRejectedValue(failure);
  await import('../src/server.js');
  signal('SIGTERM');
  await vi.waitFor(() => {
    expect(dependencies.error).toHaveBeenCalledExactlyOnceWith(
      { err: failure },
      'Server shutdown failed',
    );
    expect(lifecycle.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
