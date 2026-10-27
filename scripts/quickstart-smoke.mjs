import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain, repositoryRoot } from './release-utils.mjs';
import { deadline, processGroupAlive, waitUntilReady } from './release-smoke-process.mjs';
import { verifyResponse } from './release-smoke-http.mjs';

const activeCommands = new Set();
let interrupted = false;

export function quickstartCommands(readme) {
  const section = readme.split('## Quick start\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'Missing README quick start');
  const blocks = [...section.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const setup = blocks[0]?.split('\n');
  assert.deepEqual(
    setup,
    ['npm ci', 'npm run build', 'npm start'],
    'Review changed setup commands',
  );
  const uploads = blocks.filter((block) => block.startsWith('curl '));
  assert.equal(uploads.length, 2, 'Expected both documented curl uploads');
  return { setup, uploads };
}

export function verifyCurl(output) {
  const boundary = output.indexOf('\r\n\r\n');
  assert.ok(boundary > 0, 'curl must include HTTP headers');
  const [statusLine, ...lines] = output.slice(0, boundary).split('\r\n');
  const headers = Object.fromEntries(
    lines.map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
  verifyResponse(
    {
      status: Number(/^HTTP\/1\.[01] (\d{3}) /.exec(statusLine)?.[1]),
      headers,
      body: JSON.parse(output.slice(boundary + 4)),
    },
    { status: 200, frameCount: 32 },
    'README curl upload',
  );
}

export async function requireDefaultPortFree() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3000, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

// The documented Bash commands run on POSIX CI. Each command owns an isolated
// process group, including npm's shell and server descendants.
export function startCommand(command, cwd = repositoryRoot) {
  assert.notEqual(process.platform, 'win32', 'Quick-start smoke requires POSIX Bash and curl');
  assert.equal(interrupted, false, 'Quick-start smoke interrupted');
  const env = { ...process.env };
  for (const key of [
    'HOST',
    'PORT',
    'MAX_UPLOAD_BYTES',
    'MAX_MULTIPART_BYTES',
    'MAX_ACTIVE_UPLOADS',
  ])
    delete env[key];
  const child = spawn('bash', ['-e', '-c', command], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { exited: false, output: '', stdout: '' };
  child.stdout.on('data', (data) => {
    state.stdout = `${state.stdout}${data}`.slice(-65_536);
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      state.output = `${state.output}${data}`.slice(-16_384);
    });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => {
      state.exited = true;
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void completion.catch(() => {});
  const runtime = { child, state, completion, baseUrl: 'http://127.0.0.1:3000' };
  activeCommands.add(runtime);
  return runtime;
}

function signalGroup(runtime, signal) {
  if (!runtime.child.pid) return;
  try {
    process.kill(-runtime.child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function cleanupCommand(runtime) {
  signalGroup(runtime, 'SIGTERM');
  try {
    await deadline(runtime.completion, 5000, 'Command shutdown deadline');
  } catch {
    // A stubborn child still must be killed and reaped after the grace period.
  }
  signalGroup(runtime, 'SIGKILL');
  await deadline(runtime.completion, 5000, 'Could not reap quick-start command');
  const until = Date.now() + 5000;
  while (processGroupAlive(runtime) && Date.now() < until) await delay(25);
  assert.equal(processGroupAlive(runtime), false, 'Quick-start command leaked descendants');
  activeCommands.delete(runtime);
}

export async function withSignalCleanup(operation) {
  let shutdown;
  const interrupt = (signal) => {
    interrupted = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    shutdown = Promise.allSettled([...activeCommands].map(cleanupCommand));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
  try {
    await operation();
  } catch (error) {
    if (!shutdown) throw error;
  } finally {
    await shutdown;
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt);
  }
}

export async function runCommand(command, milliseconds, cwd = repositoryRoot) {
  console.log(`$ ${command}`);
  const runtime = startCommand(command, cwd);
  try {
    const result = await deadline(runtime.completion, milliseconds, `${command}: deadline`);
    assert.deepEqual(result, { code: 0, signal: null }, `${command}\n${runtime.state.output}`);
    return runtime.state.stdout;
  } catch (error) {
    throw new Error(`${error.message}\n${runtime.state.output}`, { cause: error });
  } finally {
    await cleanupCommand(runtime);
  }
}

export async function smokeQuickstart() {
  assert.notEqual(process.platform, 'win32', 'Quick-start smoke requires POSIX Bash and curl');
  for (const path of ['node_modules', 'dist'])
    assert.equal(
      existsSync(join(repositoryRoot, path)),
      false,
      `Use a clean checkout: ${path} exists`,
    );
  const { setup, uploads } = quickstartCommands(
    await readFile(join(repositoryRoot, 'README.md'), 'utf8'),
  );
  await requireDefaultPortFree();
  await runCommand(setup[0], 300_000);
  await runCommand(setup[1], 60_000);
  console.log(`$ ${setup[2]}`);
  const runtime = startCommand(setup[2]);
  try {
    await waitUntilReady(runtime);
    for (const command of uploads) verifyCurl(await runCommand(command, 10_000));
    assert.equal(runtime.state.exited, false, 'npm start exited before uploads completed');
  } catch (error) {
    throw new Error(`${error.message}\n${runtime.state.output}`, { cause: error });
  } finally {
    await cleanupCommand(runtime);
  }
  await requireDefaultPortFree();
  console.log(
    'README quick start passed: both uploads returned HTTP 200, JSON frameCount 32; server cleaned up.',
  );
}

if (isMain(import.meta.url)) await withSignalCleanup(smokeQuickstart);
