import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertParserTestDiscovery } from './parser-test-discovery.mjs';

const first = 'tests/mp3/count.test.ts';
const future = 'tests/mp3/future-module/unknown.test.ts';
const adapter = 'tests/server.test.ts';

test('unknown nested parser suites need no filename-list update', () => {
  const result = assertParserTestDiscovery(
    [future, first],
    [adapter, first, future],
    [future, first],
  );
  assert.deepEqual(result.parserFiles, [first, future]);
  assert.equal(result.ordinaryFileCount, 3);
  assert.equal(result.mutationFileCount, 2);
});

test('empty, duplicate, omitted and widened native inventories fail closed', () => {
  assert.throws(() => assertParserTestDiscovery([], [], []), /No parser test suites/);
  assert.throws(() => assertParserTestDiscovery([first], [first], [first, first]), /Duplicate/);
  assert.throws(
    () => assertParserTestDiscovery([first, future], [first, future], [first]),
    /Mutation Vitest discovery differs/,
  );
  assert.throws(
    () => assertParserTestDiscovery([first, future], [first], [first]),
    /Ordinary Vitest discovery does not include every/,
  );
  assert.throws(
    () => assertParserTestDiscovery([first], [first, adapter], [first, adapter]),
    /Mutation Vitest discovery differs/,
  );
});
