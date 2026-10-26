import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeRuntime } from './release-smoke.mjs';
import {
  deadline,
  launchRuntime,
  waitUntilReady,
  stopRuntime,
  cleanupRuntime,
  processGroupAlive,
} from './release-smoke-process.mjs';

async function withRuntimeDirectory(code, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'release-smoke-process-test-'));
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'dist/server.js'), code);
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function temporaryRuntime(code, callback) {
  await withRuntimeDirectory(code, async (directory) => {
    const runtime = await launchRuntime(directory);
    try {
      await callback(runtime);
    } finally {
      await cleanupRuntime(runtime);
    }
  });
}

test('startup failure reaps its isolated child; bounded deadlines reject stalled work', async () => {
  await assert.rejects(deadline(new Promise(() => {}), 10, 'bounded deadline'), /bounded deadline/);
  await temporaryRuntime('process.exit(3);', async (runtime) => {
    await assert.rejects(waitUntilReady(runtime), /exited during startup/);
    await runtime.completion;
    assert.equal(processGroupAlive(runtime), false);
  });
});

const serverCode = `const http = require('node:http');
const app = http.createServer((_request, reply) => {
  reply.writeHead(404, { 'content-type': 'application/json' });
  reply.end(JSON.stringify({ error: 'not-found', message: 'Route not found' }));
});
process.on('SIGTERM', () => app.close());
app.listen(Number(process.env.PORT), process.env.HOST);`;

// Windows SIGTERM terminates the process instead of delivering a catchable signal.
test(
  'graceful SIGTERM leaves no server process group',
  { skip: process.platform === 'win32' },
  async () => {
    await temporaryRuntime(serverCode, async (runtime) => {
      await waitUntilReady(runtime);
      assert.equal(await stopRuntime(runtime), 0);
      assert.equal(processGroupAlive(runtime), false);
    });
  },
);

test('failure cleanup leaves no server process on every platform', async () => {
  await temporaryRuntime(serverCode, async (runtime) => {
    await waitUntilReady(runtime);
    await cleanupRuntime(runtime);
    assert.equal(processGroupAlive(runtime), false);
  });
});

for (const [mode, label] of [
  ['transport', 'cbr/raw/default'],
  ['startup', 'startup'],
]) {
  test(`${mode} failure identifies the scenario and retains only bounded server output`, async () => {
    const code = `const http = require('node:http');
process.stdout.write('DISCARDED_PREFIX' + '.'.repeat(18000) + 'SERVER_OUTPUT_TAIL');
http.createServer((request, reply) => {
  if (request.method === 'POST') return request.socket.destroy();
  reply.writeHead(${mode === 'startup' ? 200 : 404}, { 'content-type': 'application/json' });
  reply.end(JSON.stringify({ error: 'not-found', message: 'Route not found' }));
}).listen(Number(process.env.PORT), process.env.HOST);`;
    await withRuntimeDirectory(code, async (directory) => {
      await assert.rejects(smokeRuntime(directory), (error) => {
        assert.ok(error.message.startsWith(`${label}: `));
        assert.ok(error.cause instanceof Error);
        if (mode === 'startup') assert.match(error.message, /startup deadline/);
        else assert.equal(error.cause.code, 'ECONNRESET');
        const output = error.message.split(
          '\nPackaged server output (last 16384 characters):\n',
        )[1];
        assert.equal(
          output,
          `${'.'.repeat(16_384 - 'SERVER_OUTPUT_TAIL'.length)}SERVER_OUTPUT_TAIL`,
        );
        assert.doesNotMatch(error.message, /DISCARDED_PREFIX/);
        return true;
      });
    });
  });
}

for (const name of ['MAX_UPLOAD_BYTES', 'MAX_MULTIPART_BYTES']) {
  test(`packaged smoke ignores ${name} deployment overrides`, async () => {
    const previous = process.env[name];
    process.env[name] = 'invalid-inherited-setting';
    try {
      await temporaryRuntime(
        `process.exit(process.env.${name} === undefined ? 0 : 9);`,
        async (runtime) => assert.deepEqual(await runtime.completion, { code: 0, signal: null }),
      );
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
}
