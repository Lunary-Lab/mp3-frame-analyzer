import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  currentSources,
  partitionSources,
  validateShardEvidence,
  assertShardTestInventory,
} from './full-mutations.mjs';
import { sha256 } from './mutation-policy.mjs';
import { assertEncoderShardDiscovery, ENCODER_TEST_NAMES } from './verify-encoder-discovery.mjs';

test('whole-file partitions are complete, deterministic and bounded without empty jobs', () => {
  assert.throws(() => partitionSources([]), /Empty/);
  assert.throws(() => partitionSources(['a', 'a']), /Duplicate/);
  for (const count of [1, 2, 8, 11, 12, 25]) {
    const files = Array.from({ length: count }, (_, index) => `src/mp3/${index}.ts`);
    const scopes = partitionSources(files);
    assert.equal(scopes.length, Math.min(11, count));
    assert.ok(scopes.every((scope) => scope.length > 0));
    assert.deepEqual(scopes.flat().sort(), files.toSorted());
    assert.deepEqual(partitionSources(files.toReversed()), scopes);
  }
});

test('native source discovery picks up new nested files and excludes declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp3-shard-discovery-'));
  try {
    await mkdir(join(root, 'src/mp3/nested'), { recursive: true });
    await writeFile(join(root, 'src/mp3/a.ts'), 'a');
    await writeFile(join(root, 'src/mp3/types.d.ts'), 'declare const a: number;');
    assert.deepEqual([...(await currentSources(root)).keys()], ['src/mp3/a.ts']);
    await writeFile(join(root, 'src/mp3/nested/new.ts'), 'b');
    assert.deepEqual(
      [...(await currentSources(root)).entries()],
      [
        ['src/mp3/a.ts', 'a'],
        ['src/mp3/nested/new.ts', 'b'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function evidence() {
  const scopes = [['src/mp3/a.ts'], ['src/mp3/b.ts']];
  const expected = { commit: 'a'.repeat(40), run: '123', attempt: '2' };
  const inputs = {
    files: [['src/mp3/a.ts', 420, 'digest']],
    runtime: {},
    environmentSha256: 'env',
  };
  const entries = scopes.map((scope, shard) => {
    const bytes = JSON.stringify({ files: { [scope[0]]: { source: 'source', mutants: [] } } });
    return {
      bytes,
      manifest: {
        ...expected,
        shard,
        scope,
        inputs,
        reportSha256: sha256(bytes),
        completed: true,
      },
    };
  });
  return { scopes, expected, inputs, entries };
}
const validate = (f) => validateShardEvidence(f.entries, f.scopes, f.expected, f.inputs);

test('evidence accepts report-local IDs without changing raw bytes or statuses', () => {
  const f = evidence();
  const original = structuredClone(f);
  assert.equal(validate(f).length, 2);
  assert.deepEqual(f, original);
});

for (const [name, change] of [
  ['missing shard', (f) => f.entries.pop()],
  ['extra shard', (f) => f.entries.push(f.entries[0])],
  [
    'duplicate shard index',
    (f) => {
      f.entries[1].manifest.shard = 0;
    },
  ],
  [
    'prior workflow run',
    (f) => {
      f.entries[0].manifest.run = '122';
    },
  ],
  [
    'prior workflow attempt',
    (f) => {
      f.entries[0].manifest.attempt = '1';
    },
  ],
  [
    'different source commit',
    (f) => {
      f.entries[0].manifest.commit = 'b'.repeat(40);
    },
  ],
  [
    'missing completion',
    (f) => {
      delete f.entries[0].manifest.completed;
    },
  ],
  [
    'failed completion',
    (f) => {
      f.entries[0].manifest.completed = false;
    },
  ],
  [
    'changed input',
    (f) => {
      f.entries[0].manifest.inputs = { files: [] };
    },
  ],
  [
    'different assignment',
    (f) => {
      f.entries[0].manifest.scope = f.scopes[1];
    },
  ],
  [
    'changed raw report',
    (f) => {
      f.entries[0].bytes += ' ';
    },
  ],
])
  test(`collector rejects ${name}`, () => {
    const f = evidence();
    change(f);
    assert.throws(() => validate(f));
  });

test('encoder coverage combines names only after resolving each report local test IDs', () => {
  const reports = [0, 1].map((shard) => ({
    testFiles: {
      'tests/mp3/free-format-real.test.ts': {
        tests: ENCODER_TEST_NAMES.map((name, index) => ({ name, id: String(index + shard) })),
      },
    },
    files: {
      [`src/mp3/${shard}.ts`]: { mutants: [{ coveredBy: shard ? ['3', '4', '5'] : ['0', '1'] }] },
    },
  }));
  assert.equal(assertEncoderShardDiscovery(reports), 5);
  const original = structuredClone(reports);
  reports[1].files['src/mp3/1.ts'].mutants[0].coveredBy = ['2', '3', '4'];
  assert.throws(() => assertEncoderShardDiscovery(reports), /did not cover/);
  original[1].testFiles['tests/mp3/free-format-real.test.ts'].tests.pop();
  assert.throws(() => assertEncoderShardDiscovery(original), /missing or skipped/);
});

test('all shards retain every native test file and test, ignoring only local IDs and order', () => {
  const file = 'tests/mp3/example.test.ts';
  const tests = ['a', 'b'].map((name, index) => ({
    name,
    id: String(index),
    location: { start: { line: index + 1, column: 1 } },
  }));
  const first = { testFiles: { [file]: { source: 'same source', tests } } };
  const second = structuredClone(first);
  second.testFiles[file].tests.reverse().forEach((test) => {
    test.id += '-second';
  });
  assert.doesNotThrow(() => assertShardTestInventory([first, second], [file]));
  second.testFiles[file].tests.pop();
  assert.throws(
    () => assertShardTestInventory([first, second], [file]),
    /Inconsistent shard test inventory/,
  );
  assert.throws(
    () => assertShardTestInventory([first, { testFiles: {} }], [file]),
    /Incomplete shard test files/,
  );
  assert.throws(
    () => assertShardTestInventory([first], [file, 'tests/mp3/new.test.ts']),
    /Incomplete shard test files/,
  );
});
