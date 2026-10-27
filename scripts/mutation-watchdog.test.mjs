import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./mutation-process.mjs', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('mutation-process.mjs', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'runMutationProcess',
);
assert.ok(declaration, 'Exercise the actual runner function, not a test-side reimplementation');
const implementation = `(${declaration.getText(parsed).replace(/^export /, '')})`;
const budget = 90 * 60 * 1000;

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const timers = new Map();
  const killed = [];
  const calls = [];
  const process = Object.assign(new EventEmitter(), {
    platform: 'linux',
    execPath: '/fixture/node',
    stdout: { write() {} },
    stderr: { write() {} },
    kill(pid, signal) {
      killed.push({ pid, signal });
      child.emit('close', null, signal);
    },
  });
  const run = runInNewContext(implementation, {
    root: '/fixture/root',
    process,
    spawn(...args) {
      calls.push(args);
      return child;
    },
    setTimeout(callback, milliseconds) {
      const timer = {};
      timers.set(timer, { callback, milliseconds });
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
  });
  const pending = run('/fixture/cli.mjs', ['--full'], {}, { write() {} });
  function clean() {
    assert.equal(timers.size, 0);
    assert.equal(process.listenerCount('SIGINT'), 0);
    assert.equal(process.listenerCount('SIGTERM'), 0);
  }
  return { child, timers, killed, calls, process, pending, clean };
}

test('the finite 90-minute child watchdog fits inside the 100-minute parser job', async () => {
  const f = fixture();
  const timer = [...f.timers.values()][0];
  assert.equal(timer.milliseconds, budget);
  assert.equal(f.calls[0][2].detached, true);
  const rejected = assert.rejects(f.pending, /interrupted=wall-clock limit/);
  timer.callback();
  await rejected;
  assert.deepEqual(f.killed, [{ pid: -4242, signal: 'SIGKILL' }]);
  f.clean();
  const workflow = readFileSync(
    new URL('../.github/workflows/mutation.yml', import.meta.url),
    'utf8',
  );
  for (const name of ['ordinary', 'shard']) {
    const mutation = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z-]*:\n/)[0];
    assert.ok(mutation, 'Both native parser execution jobs must remain present');
    assert.match(mutation, /timeout-minutes: 100\n/);
  }
  const config = JSON.parse(readFileSync(new URL('../stryker.config.json', import.meta.url)));
  assert.equal(config.timeoutMS, 2000);
  assert.deepEqual(config.mutate, ['src/mp3/**/*.ts']);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} kills the child process group and releases watchdog listeners`, async () => {
    const f = fixture();
    const rejected = assert.rejects(f.pending, new RegExp(`interrupted=${signal}`));
    f.process.emit(signal);
    await rejected;
    assert.deepEqual(f.killed, [{ pid: -4242, signal: 'SIGKILL' }]);
    f.clean();
  });
}

for (const [name, event, args, error] of [
  ['success', 'close', [0, null], undefined],
  ['failure', 'close', [1, null], /code=1/],
  ['signal termination', 'close', [null, 'SIGTERM'], /signal=SIGTERM/],
  ['spawn failure', 'error', [new Error('Fixture spawn failure')], /Fixture spawn failure/],
]) {
  test(`child ${name} clears its timer and both interrupt handlers`, async () => {
    const f = fixture();
    const result = error ? assert.rejects(f.pending, error) : f.pending;
    f.child.emit(event, ...args);
    await result;
    assert.deepEqual(f.killed, []);
    f.clean();
  });
}

test('the actual watchdog reaps a real bounded child without leaking signal listeners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-mutation-watchdog-'));
  const cli = join(directory, 'wait.mjs');
  const before = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
  let child;
  let requestedBudget;
  let cleared = false;
  let safetyFired = false;
  const safety = setTimeout(() => {
    if (child?.exitCode === null && child?.signalCode === null) {
      safetyFired = true;
      child.kill('SIGKILL');
    }
  }, 5000);
  try {
    await writeFile(cli, 'setInterval(() => {}, 1000);\n');
    // Execute the exact trusted repository function. Only its timer is accelerated;
    // native process-group termination and child close/reaping remain real.
    const run = runInNewContext(implementation, {
      root: directory,
      process,
      spawn(...args) {
        child = spawn(...args);
        return child;
      },
      setTimeout(callback, milliseconds) {
        requestedBudget = milliseconds;
        return setTimeout(callback, 50);
      },
      clearTimeout(timer) {
        cleared = true;
        clearTimeout(timer);
      },
    });
    await assert.rejects(run(cli, [], {}, { write() {} }), /interrupted=wall-clock limit/);
    assert.equal(
      safetyFired,
      false,
      'The watchdog, not the test safety timer, must reap the child',
    );
    assert.equal(requestedBudget, budget);
    assert.equal(cleared, true);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
      before,
    );
  } finally {
    clearTimeout(safety);
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
