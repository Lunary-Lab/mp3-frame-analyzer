import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { sendRequest, verifyResponse } from './release-smoke-http.mjs';

export function deadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function monitor(child) {
  const state = { exited: false, output: '' };
  const capture = (data) => {
    state.output = `${state.output}${data}`.slice(-16_384);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      state.exited = true;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      state.exited = true;
      resolve({ code, signal });
    });
  });
  void completion.catch(() => {}); // The startup gate observes failures without an unhandled rejection.
  return { child, state, completion };
}

export async function launchRuntime(runtime) {
  const port = await availablePort();
  const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) };
  // Verify documented defaults, not the caller's deployment limits.
  delete env.MAX_UPLOAD_BYTES;
  delete env.MAX_MULTIPART_BYTES;
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: runtime,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ...monitor(child), baseUrl: `http://127.0.0.1:${port}` };
}

export async function waitUntilReady(runtime) {
  const until = Date.now() + 10_000;
  for (;;) {
    assert.equal(
      runtime.state.exited,
      false,
      `Packaged server exited during startup:\n${runtime.state.output}`,
    );
    try {
      const response = await sendRequest(runtime.baseUrl, { method: 'GET', path: '/' }, 500);
      verifyResponse(response, { status: 404, error: 'not-found' }, 'startup');
      return;
    } catch (error) {
      if (Date.now() >= until)
        throw new Error(`Packaged server startup deadline: ${error.message}`, { cause: error });
      await delay(50);
    }
  }
}

function groupPid(runtime) {
  return process.platform === 'win32' ? runtime.child.pid : -runtime.child.pid;
}

export function processGroupAlive(runtime) {
  if (!runtime.child.pid) return false;
  try {
    process.kill(groupPid(runtime), 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function stopRuntime(runtime) {
  assert.equal(runtime.state.exited, false, 'Packaged server exited before graceful shutdown');
  assert.equal(runtime.child.kill('SIGTERM'), true, 'Could not signal packaged server');
  const shutdown = await deadline(runtime.completion, 15_000, 'Packaged server shutdown deadline');
  assert.deepEqual(
    shutdown,
    { code: 0, signal: null },
    `Unclean server shutdown:\n${runtime.state.output}`,
  );
  assert.equal(processGroupAlive(runtime), false, 'Packaged server leaked a child process');
  return shutdown.code;
}

export async function cleanupRuntime(runtime) {
  if (!processGroupAlive(runtime)) return;
  process.kill(groupPid(runtime), 'SIGKILL');
  await deadline(runtime.completion, 5000, 'Could not reap packaged server');
  assert.equal(processGroupAlive(runtime), false, 'Packaged server process group survived cleanup');
}
