import assert from 'node:assert/strict';
import { relative, sep } from 'node:path';

function lockedNodes(lock) {
  return new Map(
    Object.entries(lock.packages)
      .filter(([, record]) => record.dev !== true)
      .map(([path, record]) => {
        const alias = path.split('node_modules/').at(-1);
        const name = path === '' ? lock.name : (record.name ?? alias);
        return [path, { record, name, alias, id: `${name}@${record.version}` }];
      }),
  );
}

function identifyNode(node, root, locked) {
  assert.ok(
    node && typeof node === 'object' && !Array.isArray(node),
    'Malformed native npm graph node',
  );
  assert.equal(typeof node.path, 'string', 'Native npm graph node has no lock path');
  const path = relative(root, node.path).split(sep).join('/');
  const item = locked.get(path);
  assert.ok(item, 'Native npm graph has an unexpected lock path');
  assert.ok([item.name, item.alias].includes(node.name), 'Native npm graph name mismatch');
  assert.equal(node.version, item.record.version, 'Native npm graph version mismatch');
  assert.equal(node.extraneous, false, 'Extraneous native npm graph node');
  assert.ok(
    !node.missing && !node.invalid && !node.problems?.length,
    'Invalid native npm graph node',
  );
  return { path, ...item };
}

function optionalDependency(record, name) {
  if (Object.hasOwn(record.optionalDependencies ?? {}, name)) return true;
  if (Object.hasOwn(record.dependencies ?? {}, name)) return false;
  return (
    Object.hasOwn(record.peerDependencies ?? {}, name) &&
    record.peerDependenciesMeta?.[name]?.optional === true
  );
}

function presentChildren(children, declared, record) {
  const present = [];
  for (const [name, child] of Object.entries(children)) {
    assert.ok(Object.hasOwn(declared, name), 'Undeclared native npm graph edge');
    assert.ok(
      child && typeof child === 'object' && !Array.isArray(child),
      'Malformed native npm graph child',
    );
    if (Object.keys(child).length === 0) {
      assert.ok(optionalDependency(record, name), 'Missing required native npm graph child');
    } else present.push(child);
  }
  return present;
}

function childrenOf(node, item) {
  const declared = {
    ...item.record.dependencies,
    ...item.record.optionalDependencies,
    ...item.record.peerDependencies,
  };
  const children = node.dependencies ?? {};
  assert.ok(
    children && typeof children === 'object' && !Array.isArray(children),
    'Malformed native npm graph edges',
  );
  const expanded = Object.hasOwn(node, 'dependencies') || Object.keys(declared).length === 0;
  if (expanded) {
    for (const name of Object.keys(declared)) {
      assert.ok(
        Object.hasOwn(children, name) || optionalDependency(item.record, name),
        'Missing native npm graph edge',
      );
    }
  }
  return { expanded, present: presentChildren(children, declared, item.record) };
}

// npm ls resolves aliases, peers, hoisting and nested versions using Arborist.
// This adapter checks its exact locked identities and compares the resulting
// logical edges; it does not resolve package names or semver itself.
export function validateResolvedGraph(sbom, lock, tree, root) {
  assert.equal(tree.path, root, 'Native npm graph root mismatch');
  const locked = lockedNodes(lock);
  const expanded = new Set();
  const graph = new Map([...locked.values()].map(({ id }) => [id, new Set()]));
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    const item = identifyNode(node, root, locked);
    const children = childrenOf(node, item);
    if (children.expanded) expanded.add(item.path);
    for (const child of children.present) {
      graph.get(item.id).add(identifyNode(child, root, locked).id);
      pending.push(child);
    }
  }
  assert.deepEqual(
    [...expanded].sort(),
    [...locked.keys()].sort(),
    'Incomplete native npm graph expansion',
  );
  assert.deepEqual(
    sbom.dependencies.map(({ ref }) => ref).sort(),
    [...graph.keys()].sort(),
    'Incomplete production SBOM graph nodes',
  );
  for (const { ref, dependsOn } of sbom.dependencies) {
    assert.deepEqual(
      [...dependsOn].sort(),
      [...graph.get(ref)].sort(),
      `Production SBOM dependency edges mismatch: ${ref}`,
    );
  }
}
