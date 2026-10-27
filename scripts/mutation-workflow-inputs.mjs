import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';

export const CI_WORKFLOW = '.github/workflows/ci.yml';
const rootKeys = new Set([
  'name',
  'run-name',
  'on',
  'permissions',
  'env',
  'defaults',
  'concurrency',
  'jobs',
]);
const jobId = /^[A-Za-z_][A-Za-z0-9_-]*$/;
function requireWorkflow(condition, reason) {
  if (!condition) throw new Error(`Unsupported mutation workflow: ${reason}`);
}

function parseSafely(source) {
  try {
    return parseDocument(source, {
      version: '1.2',
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      merge: false,
      resolveKnownTags: false,
    });
  } catch {
    // Parser exceptions can include source excerpts. Cache diagnostics may not.
    return null;
  }
}

function parseWorkflow(source) {
  requireWorkflow(typeof source === 'string' && source.length <= 262144, 'source size');
  const document = parseSafely(source);
  requireWorkflow(document !== null, 'parser rejected input');
  requireWorkflow(!document.errors.length && !document.warnings.length, 'invalid YAML');
  requireWorkflow(!document.directives.yaml.explicit, 'YAML version directive');
  requireWorkflow(Object.keys(document.directives.tags).length === 1, 'YAML tag directive');
  visit(document, (_, node) => {
    requireWorkflow(!isAlias(node) && !node?.anchor && !node?.tag, 'YAML alias, anchor or tag');
    if (isMap(node))
      requireWorkflow(
        node.items.every(({ key }) => isScalar(key) && key.value !== '<<'),
        'mapping key or merge',
      );
    else if (isScalar(node))
      requireWorkflow(
        typeof node.value !== 'number' || Number.isFinite(node.value),
        'non-finite scalar',
      );
    else requireWorkflow(!node || isSeq(node) || 'key' in node, 'YAML node');
  });
  // Aliases are deliberately unsupported, so no graph expansion is permitted.
  try {
    return document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  } catch {
    return null;
  }
}

function prerequisites(job) {
  const value = job.get('needs');
  if (value === undefined) return [];
  const needs = Array.isArray(value) ? value : [value];
  requireWorkflow(
    needs.every((name) => typeof name === 'string' && jobId.test(name)),
    'dynamic or invalid needs',
  );
  return needs;
}

function mutationJobs(jobs) {
  requireWorkflow(jobs instanceof Map && jobs.has('mutation'), 'missing mutation job');
  const selected = new Map();
  const visiting = new Set();
  function include(name) {
    requireWorkflow(!visiting.has(name), 'cyclic needs');
    if (selected.has(name)) return;
    requireWorkflow(visiting.size < 64, 'needs depth');
    const job = jobs.get(name);
    requireWorkflow(job instanceof Map, 'missing or invalid job');
    visiting.add(name);
    for (const dependency of prerequisites(job)) include(dependency);
    visiting.delete(name);
    selected.set(name, job);
  }
  include('mutation');
  return selected;
}

function canonical(value, depth = 0) {
  requireWorkflow(depth <= 64, 'mapping depth');
  if (value instanceof Map)
    return Object.fromEntries(
      [...value.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item, depth + 1)]),
    );
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  return value;
}

// Compare execution data, never execute workflow expressions or shell code.
// Keep every root field and each complete mutation prerequisite job. Only
// independent jobs and YAML presentation may differ across reusable snapshots.
export function mutationWorkflowInput(source) {
  const workflow = parseWorkflow(source);
  requireWorkflow(workflow instanceof Map && workflow.has('on'), 'workflow mapping or trigger');
  requireWorkflow(
    [...workflow.keys()].every((key) => rootKeys.has(key)),
    'unknown root key',
  );
  workflow.set('jobs', mutationJobs(workflow.get('jobs')));
  return canonical(workflow);
}
