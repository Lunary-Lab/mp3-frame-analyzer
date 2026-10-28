import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  cleanupCommand,
  quickstartCommands,
  requireDefaultPortFree,
  runCommand,
  startCommand,
  verifyCurl,
} from './quickstart-smoke.mjs';
import { deadline, processGroupAlive, waitUntilReady } from './release-smoke-process.mjs';

test('source smoke executes the README install/build/start and both curl blocks verbatim', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const commands = quickstartCommands(readme);
  assert.deepEqual(commands.setup, ['npm ci', 'npm run build', 'npm start']);
  assert.match(commands.uploads[0], /-F 'file=@tests\/fixtures\/cbr\.mp3;type=audio\/mpeg'/);
  assert.match(commands.uploads[1], /--data-binary @tests\/fixtures\/cbr\.mp3/);
  for (const command of commands.uploads) {
    assert.ok(readme.includes(command));
    assert.match(command, /^curl -i -X POST http:\/\/127\.0\.0\.1:3000\/file-upload \\\n/);
  }
  assert.throws(() => quickstartCommands(readme.replace('npm start\n', 'node dist/server.js\n')));
  assert.throws(() => quickstartCommands(readme.replace('curl -i', 'curl-removed -i')));
});

test('curl success requires HTTP 200, JSON content type and the exact independent count', () => {
  const response = (status = 200, type = 'application/json', body = '{"frameCount":32}') =>
    `HTTP/1.1 ${status} OK\r\nContent-Type: ${type}\r\n\r\n${body}`;
  verifyCurl(response());
  for (const invalid of [
    response(404),
    response(200, 'text/plain'),
    response(200, 'application/json', '{"frameCount":33}'),
    response(200, 'application/json', '{"frameCount":"32"}'),
    response(200, 'application/json', '{"frameCount":32,"extra":true}'),
    response(200, 'application/json', 'not json'),
    '{"frameCount":32}',
  ])
    assert.throws(() => verifyCurl(invalid));
});

test('an existing listener cannot satisfy source-smoke readiness', async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3000, '127.0.0.1', resolve);
  });
  try {
    await assert.rejects(requireDefaultPortFree(), { code: 'EADDRINUSE' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CI runs the source smoke before packaging, preserving lock verification and artifact smoke', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = ci.jobs.package.steps;
  const setup = steps.findIndex((step) => step.uses === './.github/actions/setup-project');
  assert.equal(steps[setup].with.install, 'false');
  assert.equal(steps[setup + 1].run, 'node scripts/verify-npm-lock.mjs');
  assert.equal(steps[setup + 2].run, 'node scripts/quickstart-smoke.mjs');
  assert.match(steps[setup + 3].run, /npm run package:release/);
  assert.equal(steps[setup + 4].run, 'npm run test:artifact');
});

test(
  'startup failures and timed-out commands clean their process groups',
  { skip: process.platform === 'win32' },
  async () => {
    const failed = startCommand('exit 7');
    try {
      await assert.rejects(waitUntilReady(failed), /exited during startup/);
    } finally {
      await cleanupCommand(failed);
    }
    assert.equal(processGroupAlive(failed), false);
    const directory = await mkdtemp(join(tmpdir(), 'quickstart-timeout-'));
    try {
      await writeFile(
        join(directory, 'hang.mjs'),
        "import { writeFileSync } from 'node:fs'; writeFileSync('pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      );
      await assert.rejects(runCommand('node hang.mjs', 1000, directory), /deadline/);
      const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'cleanup reaps a shell and its listening descendant after success or an assertion failure',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quickstart-cleanup-'));
    await writeFile(
      join(directory, 'server.mjs'),
      `import { createServer } from 'node:http';
const server = createServer((_request, response) => response.writeHead(404,
  { 'content-type': 'application/json' }).end('{"error":"not-found","message":"Route not found"}'));
process.on('SIGTERM', () => server.close());
server.listen(3000, '127.0.0.1');`,
    );
    try {
      for (const fail of [false, true]) {
        const runtime = startCommand('node server.mjs & wait', directory);
        const operation = async () => {
          try {
            await waitUntilReady(runtime);
            if (fail) verifyCurl('bad response');
          } finally {
            await cleanupCommand(runtime);
          }
        };
        if (fail) await assert.rejects(operation(), /include HTTP headers/);
        else await operation();
        assert.equal(processGroupAlive(runtime), false);
        await requireDefaultPortFree();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'interrupting the smoke harness cleans its detached command',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quickstart-interrupt-'));
    const moduleUrl = new URL('./quickstart-smoke.mjs', import.meta.url).href;
    await writeFile(
      join(directory, 'hang.mjs'),
      'console.log(process.pid); setInterval(() => {}, 1000);',
    );
    await writeFile(
      join(directory, 'driver.mjs'),
      `
import { startCommand, withSignalCleanup } from ${JSON.stringify(moduleUrl)};
await withSignalCleanup(async () => {
  const runtime = startCommand('node hang.mjs', process.cwd());
  runtime.child.stdout.once('data', (data) => process.stdout.write(data));
  await runtime.completion;
});`,
    );
    const child = spawn(process.execPath, ['driver.mjs'], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const completion = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    let pid;
    try {
      pid = Number(
        await deadline(
          new Promise((resolve) => child.stdout.once('data', resolve)),
          5000,
          'Child readiness',
        ),
      );
      assert.equal(child.kill('SIGTERM'), true);
      assert.deepEqual(await deadline(completion, 15_000, 'Interrupt cleanup'), {
        code: 143,
        signal: null,
      });
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      child.kill('SIGKILL');
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          assert.equal(error.code, 'ESRCH');
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
