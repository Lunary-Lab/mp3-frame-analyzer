import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createStructuredMp3 } from '../fuzz/create-structured.mjs';
import { classifyReplayProcess } from './classify-replay.mjs';
import { minimizeBytes } from './minimize-core.mjs';

function constructionCorpus() {
  const inputs = [Buffer.alloc(0)];
  for (let value = 0; value < 256; value++) inputs.push(Buffer.from([value]));
  for (let flags = 0; flags < 64; flags++) {
    for (let metadata = 0; metadata < 8; metadata++) {
      const input = Buffer.alloc(160);
      for (let i = 0; i < input.length; i++) input[i] = (i * 67 + flags * 11 + metadata) & 0xff;
      input[1] = flags;
      input[4] = metadata % 10;
      input[5] = flags % 3;
      input[6] = metadata;
      inputs.push(input);
    }
  }
  let state = 0x51a7c0de;
  for (let sample = 0; sample < 512; sample++) {
    const input = Buffer.alloc(sample % 161);
    for (let i = 0; i < input.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      input[i] = state >>> 24;
    }
    inputs.push(input);
  }
  return inputs;
}

test('structured construction retains all bytes and count/geometry manifests for 1,281 inputs', () => {
  // Characterized from main 28295f3 before extraction. Independent geometry and
  // metadata assertions remain in structured-fuzz.test.mjs; this locks byte parity.
  const digest = createHash('sha256');
  const inputs = constructionCorpus();
  assert.equal(inputs.length, 1281);
  for (const input of inputs) {
    const { bytes, ...manifest } = createStructuredMp3(input);
    digest.update(
      JSON.stringify({ input: input.toString('hex'), bytes: bytes.toString('hex'), ...manifest }),
    );
    digest.update('\n');
  }
  assert.equal(
    digest.digest('hex'),
    'd1335e4257724a876bcd9d989e096b1fc358b22bbc344e0c4ce5239c115f7972',
  );
});

test('minimizer retains ordered probes, granularity changes and probe exhaustion', async () => {
  const cases = [
    ['abcdef', () => true, 20, '', ['abcdef', 'def', 'f', '']],
    [
      'abcdef',
      (text) => text === 'abcdef',
      20,
      'abcdef',
      [
        'abcdef',
        'def',
        'abc',
        'cdef',
        'abef',
        'abcd',
        'bcdef',
        'acdef',
        'abdef',
        'abcef',
        'abcdf',
        'abcde',
      ],
    ],
    ['abcXdef', (text) => text.includes('X'), 20, 'X', ['abcXdef', 'def', 'abcX', 'cX', 'X', '']],
    ['abcXdef', (text) => text.includes('X'), 2, 'abcX', ['abcXdef', 'def', 'abcX']],
    ['abcXdef', (text) => text.includes('X'), 0, 'abcXdef', ['abcXdef']],
    ['', () => true, 20, '', ['']],
  ];
  for (const [input, reproduces, maxProbes, expected, trace] of cases) {
    const seen = [];
    const result = await minimizeBytes(
      Buffer.from(input),
      async (bytes) => {
        seen.push(bytes.toString());
        return reproduces(bytes.toString());
      },
      { maxProbes, budgetMs: 5000 },
    );
    assert.deepEqual(seen, trace);
    assert.deepEqual(result, {
      bytes: Buffer.from(expected),
      probes: trace.length - 1,
      timedOut: false,
    });
  }
});

test('minimizer always checks the original and propagates reproducer failures', async () => {
  const seen = [];
  const exhausted = await minimizeBytes(
    Buffer.from('abc'),
    async (bytes) => {
      seen.push(bytes.toString());
      return true;
    },
    { budgetMs: -1 },
  );
  assert.deepEqual(exhausted, { bytes: Buffer.from('abc'), probes: 0, timedOut: true });
  assert.deepEqual(seen, ['abc']);
  await assert.rejects(
    minimizeBytes(Buffer.from('abc'), async () => false),
    {
      name: 'Error',
      message: 'Original input does not reproduce the failure',
    },
  );
  const error = new Error('reproducer infrastructure failed');
  await assert.rejects(
    minimizeBytes(Buffer.from('abc'), async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
});

test('minimizer keeps deadline checks before each ordered probe', async () => {
  for (const [budgetMs, expected, trace, reads] of [
    [2, 'abcXdef', ['abcXdef'], 5],
    [3, 'abcXdef', ['abcXdef', 'def'], 6],
    [4, 'abcX', ['abcXdef', 'def', 'abcX'], 6],
    [6, 'cX', ['abcXdef', 'def', 'abcX', 'cX'], 8],
  ]) {
    const originalNow = Date.now;
    let now = 0;
    const seen = [];
    Date.now = () => now++;
    try {
      const result = await minimizeBytes(
        Buffer.from('abcXdef'),
        async (bytes) => {
          seen.push(bytes.toString());
          return bytes.includes(88);
        },
        { maxProbes: 50, budgetMs },
      );
      assert.deepEqual(result, {
        bytes: Buffer.from(expected),
        probes: trace.length - 1,
        timedOut: true,
      });
      assert.deepEqual(seen, trace);
      assert.equal(now, reads);
    } finally {
      Date.now = originalNow;
    }
  }
});

test('replay classifier keeps infrastructure precedence, exact messages, and causes', () => {
  const error = { code: 'ENOENT', message: 'missing executable' };
  assert.throws(() => classifyReplayProcess({ status: 0, error }), {
    message: 'Fuzz replay could not launch: missing executable',
    cause: error,
  });
  assert.equal(classifyReplayProcess({ status: 0, error: { code: 'ETIMEDOUT' } }), 'timeout');
  assert.equal(classifyReplayProcess({ status: 0, stderr: 'FUZZ_FAILURE {broken}' }), null);
  assert.throws(() => classifyReplayProcess({ status: null, signal: 'SIGKILL' }), {
    message: 'Fuzz replay exited without a recognized failure marker: exit=null, signal=SIGKILL',
  });
  assert.throws(
    () => classifyReplayProcess({ status: 1, stderr: 'FUZZ_FAILURE {broken}' }),
    (error) =>
      error.message === 'Fuzz replay produced an invalid failure marker' &&
      error.cause instanceof SyntaxError,
  );
  assert.throws(() => classifyReplayProcess({ status: 1, stderr: 'FUZZ_FAILURE {}' }), {
    message: 'Fuzz replay exited without a recognized failure marker: exit=1, signal=undefined',
  });
  for (const marker of [
    { name: '', family: 'x' },
    { name: 'Error' },
    { name: 'Error', family: '' },
    { name: 1, family: 'x' },
    { name: 'Error', family: 1 },
  ]) {
    assert.throws(
      () => classifyReplayProcess({ status: 1, stderr: `FUZZ_FAILURE ${JSON.stringify(marker)}` }),
      {
        message: 'Fuzz replay produced an incomplete failure marker',
      },
    );
  }
  assert.equal(
    classifyReplayProcess({
      status: 1,
      stderr:
        'noise\nFUZZ_FAILURE {"name":"TypeError","family":"first"}\nFUZZ_FAILURE {"name":"Error","family":"second"}\n',
    }),
    'TypeError:first',
  );
});
