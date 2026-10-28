import assert from 'node:assert/strict';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import nativePackage from '@stryker-mutator/instrumenter/package.json' with { type: 'json' };

const options = { excludedMutations: [], ignorers: [], plugins: null };
const logger = { debug() {}, info() {}, warn() {}, trace() {}, isDebugEnabled: () => false };
const position = (a, b) => a.line - b.line || a.column - b.column;
const lexical = (a, b) => (a < b ? -1 : Number(a > b));
const identity = ({ fileName, location, mutatorName, replacement }) =>
  JSON.stringify([fileName, location.start, location.end, mutatorName, replacement]);
const identities = (mutants) => mutants.map(identity).sort();

async function instrument(files) {
  const { mutants } = await new Instrumenter(logger).instrument(files, options);
  assert.ok(
    mutants.every((mutant) => mutant.status !== 'Ignored'),
    'Ignored native mutant',
  );
  return mutants;
}

function components(mutants) {
  const result = [];
  const sorted = mutants.toSorted(
    (a, b) =>
      position(a.location.start, b.location.start) || position(a.location.end, b.location.end),
  );
  for (const mutant of sorted) {
    const previous = result.at(-1);
    if (previous && position(mutant.location.start, previous.end) < 0) {
      if (position(mutant.location.end, previous.end) > 0) previous.end = mutant.location.end;
      previous.mutants.push(mutant);
    } else result.push({ fileName: mutant.fileName, ...mutant.location, mutants: [mutant] });
  }
  return result;
}

function reportIdentity({ fileName, location, mutatorName, replacement }) {
  const point = ({ line, column }) => ({ line: line + 1, column: column + 1 });
  return {
    fileName,
    location: { start: point(location.start), end: point(location.end) },
    mutatorName,
    replacement,
  };
}

async function provePartition(parts, sources) {
  const ranges = new Map();
  for (const { fileName, start, end } of parts) {
    if (!ranges.has(fileName)) ranges.set(fileName, []);
    ranges.get(fileName).push({ start, end });
  }
  const files = [...ranges].map(([name, mutate]) => ({ name, content: sources.get(name), mutate }));
  const expected = parts.flatMap((part) => part.mutants);
  assert.deepEqual(
    identities(await instrument(files)),
    identities(expected),
    'Native partition coverage differs',
  );
  return expected.map(reportIdentity);
}

// Native ranges include whole AST nodes. Overlapping mutant spans stay together;
// instrumenting the actual planned ranges proves that no boundary drops a mutant.
export async function mutationPartitions(sources, limit = 11) {
  assert.equal(nativePackage.version, '10.1.1', 'Unsupported native instrumenter version');
  assert.ok(sources instanceof Map && sources.size > 0, 'Empty parser source inventory');
  assert.ok(Number.isInteger(limit) && limit > 0, 'Invalid parser shard limit');
  const parts = [];
  const fullInventory = [];
  for (const [name, content] of [...sources].sort(([a], [b]) => lexical(a, b))) {
    assert.ok(typeof content === 'string' && content.length > 0, `Empty parser source: ${name}`);
    const mutants = await instrument([{ name, content, mutate: true }]);
    assert.ok(mutants.length > 0, `No native mutants: ${name}`);
    assert.equal(new Set(identities(mutants)).size, mutants.length, 'Duplicate native mutant');
    fullInventory.push(...mutants.map(reportIdentity));
    parts.push(...components(mutants));
  }
  parts.sort(
    (a, b) =>
      b.mutants.length - a.mutants.length ||
      lexical(a.fileName, b.fileName) ||
      position(a.start, b.start),
  );
  const length = Math.min(limit, parts.length);
  const bins = Array.from({ length }, () => ({ parts: [], count: 0 }));
  for (const part of parts) {
    const bin = bins.reduce((a, b) => (a.count <= b.count ? a : b));
    bin.parts.push(part);
    bin.count += part.mutants.length;
  }
  const scopes = bins.map((bin) =>
    bin.parts.map(
      ({ fileName, start, end }) =>
        `${fileName}:${start.line + 1}:${start.column}-${end.line + 1}:${end.column}`,
    ),
  );
  const inventories = [];
  for (const bin of bins) inventories.push(await provePartition(bin.parts, sources));
  assert.deepEqual(
    identities(inventories.flat()),
    identities(fullInventory),
    'Incomplete native partition union',
  );
  return { scopes, inventories };
}
