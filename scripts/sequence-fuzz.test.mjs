import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { createSequenceMp3 } from '../fuzz/create-sequences.mjs';

test('sequence construction varies rates and modes while retaining independent geometry', () => {
  const covered = new Set();
  for (let rate = 0; rate < 3; rate++)
    for (let modes = 0; modes < 4; modes++) {
      const input = Buffer.alloc(160);
      input[3] = rate;
      input[5] = modes & 1;
      input[10] = (modes >> 1) & 1;
      input[6] = 1;
      input[11] = 1;
      const fixture = createSequenceMp3(input);
      assert.equal(fixture.expectation.kind, 'count');
      assert.equal(fixture.frameOffsets.length, fixture.expectation.count);
      const [first, next] = fixture.configurations;
      assert.notEqual(first.rate, next.rate);
      covered.add(`${first.rate}/${Number(first.free)}/${Number(next.free)}`);
      fixture.frameOffsets.forEach((offset, i) => {
        assert.equal(fixture.bytes[offset], 255);
        assert.equal(fixture.bytes[offset + 1] & 254, 250);
        assert.ok(fixture.frameLengths[i] >= 21 && fixture.frameLengths[i] <= 2881);
        assert.ok(offset + fixture.frameLengths[i] <= fixture.bytes.length);
      });
    }
  assert.equal(covered.size, 12);
});

test('ambiguous constructions expose two complete independent boundary layouts', () => {
  for (const longer of [0, 1]) {
    const fixture = createSequenceMp3(Uint8Array.from([2, longer]));
    assert.equal(fixture.expectation.kind, 'ambiguous');
    assert.equal(fixture.bytes.length, longer ? 3780 : 864);
    assert.notEqual(fixture.frameOffsets.length, fixture.alternative.length - 1);
    assert.equal(fixture.alternative.at(-1), fixture.bytes.length);
    for (const offset of fixture.alternative.slice(0, -1)) {
      assert.equal(fixture.bytes[offset], 255);
      assert.equal(fixture.bytes[offset + 1], 251);
    }
  }
});

test('dense control confines patterns to original ancillary bytes and keeps its true prefixes zero', () => {
  const fixture = createSequenceMp3(Uint8Array.from([3]));
  assert.deepEqual(fixture.frameOffsets, [0, 900, 1800]);
  assert.deepEqual(fixture.expectation, { kind: 'count', count: 3 });
  for (const offset of fixture.frameOffsets) {
    assert.equal(fixture.bytes[offset + 2], 4);
    assert.deepEqual(fixture.bytes.subarray(offset + 4, offset + 21), Buffer.alloc(17));
    assert.deepEqual(fixture.bytes.subarray(offset + 21, offset + 24), Buffer.from([255, 251, 0]));
  }
});

test('sequence corpus includes count, ambiguity, ancillary and arbitrary domains', async () => {
  const directory = new URL('../fuzz/seeds/sequences/', import.meta.url);
  const domains = new Set();
  for (const name of await readdir(directory)) {
    const bytes = await readFile(new URL(name, directory));
    domains.add(bytes[0] % 4);
    assert.ok(createSequenceMp3(bytes).bytes.length <= 81_000);
  }
  assert.deepEqual([...domains].sort(), [0, 1, 2, 3]);
});

test('exact-count ancillary decoys are indexed, not competing legacy free-header chains', () => {
  const fixture = createSequenceMp3(Uint8Array.from([116, 133]));
  assert.deepEqual(fixture.expectation, { kind: 'count', count: 10 });
  const actual = new Set(fixture.frameOffsets);
  let decoys = 0;
  for (let offset = 0; offset + 4 <= fixture.bytes.length; offset++) {
    if (fixture.bytes[offset] === 255 && fixture.bytes[offset + 1] === 251 && !actual.has(offset)) {
      assert.equal(fixture.bytes[offset + 2] >> 4, 9);
      decoys++;
    }
  }
  assert.ok(decoys > 0);
});
