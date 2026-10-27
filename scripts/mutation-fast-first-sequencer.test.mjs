import assert from 'node:assert/strict';
import test from 'node:test';
import MutationFastFirstSequencer from './mutation-fast-first-sequencer.mjs';

function sorter(durations) {
  return new MutationFastFirstSequencer({
    cache: { getTestSpecificationResult: (file) => durations.get(file) },
  });
}

test('sorts cached durations fastest first and retains all exact input identities', async () => {
  const files = [{ moduleId: 'slow' }, { moduleId: 'fast' }, { moduleId: 'medium' }];
  const input = [...files];
  const result = await sorter(
    new Map(files.map((file, i) => [file, { duration: [100, 1, 10][i] }])),
  ).sort(files);
  assert.deepEqual(result, [files[1], files[2], files[0]]);
  assert.deepEqual(files, input);
  assert.notEqual(result, files);
  assert.equal(new Set(result).size, files.length);
  result.forEach((file) => assert.ok(input.includes(file)));
});

test('ties and unknown durations use deterministic paths without dropping unknown files', async () => {
  const files = ['z-unknown', 'b-tie', 'a-tie', 'a-unknown'].map((moduleId) => ({ moduleId }));
  const result = await sorter(
    new Map([
      [files[1], { duration: 2 }],
      [files[2], { duration: 2 }],
    ]),
  ).sort(files);
  assert.deepEqual(result, [files[2], files[1], files[3], files[0]]);
});

test('empty and duplicate specifications remain empty and duplicated respectively', async () => {
  const sequencer = sorter(new Map());
  assert.deepEqual(await sequencer.sort([]), []);
  const file = { moduleId: 'same' };
  assert.deepEqual(await sequencer.sort([file, file]), [file, file]);
});
