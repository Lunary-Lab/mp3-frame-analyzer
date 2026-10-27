import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { mutationPartitions } from './mutation-partitions.mjs';

const fixture = `export class Probe {
  first(n: number) {
    if (n > 0) { return '🎵'; }
    return 'no';
  }
  second(n: number) { while (n > 0) n--; return n; }
}
export const positive = (n: number) => n > 0;
export const greeting = '🎵'; export const enabled = true;
`;
const logger = { debug() {}, info() {}, warn() {}, trace() {}, isDebugEnabled: () => false };
const options = { excludedMutations: [], ignorers: [], plugins: null };
const key = ({ fileName, location, mutatorName, replacement }) =>
  JSON.stringify([fileName, location, mutatorName, replacement]);
const keys = (mutants) => mutants.map(key).sort();

async function fullInventory(sources, scopes) {
  const files = [...sources].flatMap(([name, content]) => {
    if (!scopes) return [{ name, content, mutate: true }];
    const mutate = scopes.flatMap((scope) => {
      const match = /^(.*):(\d+):(\d+)-(\d+):(\d+)$/.exec(scope);
      assert.ok(match, `Invalid native CLI range: ${scope}`);
      const [, file, startLine, startColumn, endLine, endColumn] = match;
      if (file !== name) return [];
      return [
        {
          start: { line: Number(startLine) - 1, column: Number(startColumn) },
          end: { line: Number(endLine) - 1, column: Number(endColumn) },
        },
      ];
    });
    return mutate.length ? [{ name, content, mutate }] : [];
  });
  const { mutants } = await new Instrumenter(logger).instrument(files, options);
  return mutants.map(({ fileName, location, mutatorName, replacement }) => ({
    fileName,
    location: Object.fromEntries(
      Object.entries(location).map(([side, { line, column }]) => [
        side,
        { line: line + 1, column: column + 1 },
      ]),
    ),
    mutatorName,
    replacement,
  }));
}

test('native partitions preserve nested block, class method and Unicode mutant identities exactly once', async () => {
  const sources = new Map([['src/probe.ts', fixture]]);
  const { scopes, inventories } = await mutationPartitions(sources);
  assert.ok(scopes.length > 1, 'Separate class methods should share work across runners');
  assert.ok(scopes.length <= 11);
  assert.equal(scopes.length, inventories.length);
  assert.ok(inventories.every((inventory) => inventory.length > 0));
  const observed = inventories.flat();
  assert.deepEqual(keys(observed), keys(await fullInventory(sources)));
  assert.equal(new Set(keys(observed)).size, observed.length);
  for (const [index, scope] of scopes.entries()) {
    assert.deepEqual(keys(await fullInventory(sources, scope)), keys(inventories[index]));
  }
  // Removing a method body spans the nested condition: it must be in one range.
  const block = observed.find(
    (mutant) => mutant.location.start.line === 2 && mutant.replacement === '{}',
  );
  assert.ok(block);
  const owner = inventories.findIndex((inventory) => inventory.includes(block));
  assert.ok(inventories[owner].some((mutant) => mutant.location.start.line === 3));
  assert.ok(observed.some((mutant) => mutant.location.start.column > 30));
});

test('assignment is deterministic across source insertion orders and respects runner limits', async () => {
  const entries = [
    ['src/z.ts', fixture],
    ['src/A.ts', fixture],
    ['src/a.ts', fixture],
  ];
  const sources = new Map(entries);
  const forward = await mutationPartitions(sources, 3);
  const reverse = await mutationPartitions(new Map(entries.toReversed()), 3);
  assert.deepEqual(reverse, forward);
  assert.equal(forward.scopes.length, 3);
  assert.deepEqual(keys(forward.inventories.flat()), keys(await fullInventory(sources)));
  const single = await mutationPartitions(sources, 1);
  assert.equal(single.scopes.length, 1);
  assert.deepEqual(keys(single.inventories.flat()), keys(forward.inventories.flat()));
});

test('one indivisible function stays whole even when many runners are requested', async () => {
  const sources = new Map([
    ['src/one.ts', 'export function f(n) { if (n > 0) return n + 1; return 0; }'],
  ]);
  const result = await mutationPartitions(sources, 11);
  assert.equal(result.scopes.length, 1);
  assert.deepEqual(keys(result.inventories.flat()), keys(await fullInventory(sources)));
});

test('empty sources, missing mutants, ignored mutants and invalid limits fail closed', async () => {
  await assert.rejects(mutationPartitions(new Map()), /Empty parser source inventory/);
  await assert.rejects(mutationPartitions(new Map([['src/empty.ts', '']])), /Empty parser source/);
  await assert.rejects(
    mutationPartitions(new Map([['src/types.ts', 'export type Number = number;']])),
    /No native mutants/,
  );
  await assert.rejects(
    mutationPartitions(
      new Map([['src/ignored.ts', '// Stryker disable all\nexport const flag = true;']]),
    ),
    /Ignored native mutant/,
  );
  for (const limit of [0, -1, 1.5, NaN]) {
    await assert.rejects(
      mutationPartitions(new Map([['src/probe.ts', fixture]]), limit),
      /Invalid parser shard limit/,
    );
  }
});

test('native re-instrumentation rejects missing, duplicate and extra partition coverage', async (t) => {
  const corruptions = {
    missing: (mutants) => mutants.slice(1),
    duplicate: (mutants) => [...mutants, mutants[0]],
    extra: (mutants) => [{ ...mutants[0], replacement: 'unexpected' }, ...mutants.slice(1)],
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    await t.test(name, async (t) => {
      const original = Instrumenter.prototype.instrument;
      t.mock.method(Instrumenter.prototype, 'instrument', async function (files, options) {
        const result = await original.call(this, files, options);
        return Array.isArray(files[0].mutate)
          ? { ...result, mutants: corrupt(result.mutants) }
          : result;
      });
      await assert.rejects(
        mutationPartitions(new Map([['src/probe.ts', fixture]])),
        /Native partition coverage differs/,
      );
    });
  }
});

test('ambiguous duplicate identities in native full inventory fail closed', async (t) => {
  const original = Instrumenter.prototype.instrument;
  t.mock.method(Instrumenter.prototype, 'instrument', async function (files, options) {
    const result = await original.call(this, files, options);
    return { ...result, mutants: [...result.mutants, result.mutants[0]] };
  });
  await assert.rejects(
    mutationPartitions(new Map([['src/probe.ts', fixture]])),
    /Duplicate native mutant/,
  );
});
