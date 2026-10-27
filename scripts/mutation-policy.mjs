import { isDeepStrictEqual } from 'node:util';
import {
  sha256,
  requireThat,
  validateSchemas,
  validateMutationConfiguration,
  validateSourceInventory,
} from './mutation-policy-inputs.mjs';
export { PARSER_GLOB, VITEST_CONFIG, sha256, sourceContext } from './mutation-policy-inputs.mjs';

/** Convert Stryker's 1-based UTF-16 coordinates into an exact source slice. */
export function originalAt(source, location) {
  const lines = source.split('\n');
  function offset(point) {
    requireThat(
      point &&
        Number.isInteger(point.line) &&
        point.line >= 1 &&
        point.line <= lines.length &&
        Number.isInteger(point.column) &&
        point.column >= 1 &&
        point.column <= lines[point.line - 1].length + 1,
      'Invalid mutation coordinates',
    );
    return (
      lines.slice(0, point.line - 1).reduce((n, line) => n + line.length + 1, 0) + point.column - 1
    );
  }
  const start = offset(location?.start);
  const end = offset(location?.end);
  requireThat(end > start, 'Empty or inverted mutation range');
  return source.slice(start, end);
}

/** IDs are deliberately excluded: generated mutant numbers change between runs. */
function identity(file, source, mutant) {
  return JSON.stringify([
    file,
    sha256(source),
    mutant.mutatorName,
    originalAt(source, mutant.location),
    mutant.replacement,
    mutant.location.start.line,
    mutant.location.start.column,
    mutant.location.end.line,
    mutant.location.end.column,
  ]);
}

function exceptionKey(entry) {
  return JSON.stringify([
    entry.file,
    entry.sourceSha256,
    entry.mutatorName,
    entry.original,
    entry.replacement,
    entry.location?.start?.line,
    entry.location?.start?.column,
    entry.location?.end?.line,
    entry.location?.end?.column,
  ]);
}

function reviewedExceptions(policy, sources) {
  requireThat(Array.isArray(policy.equivalents), 'Missing reviewed equivalent-mutant list');
  const exceptions = new Map();
  const ids = new Set();
  for (const entry of policy.equivalents) {
    requireThat(
      typeof entry.id === 'string' && entry.id.length > 0 && !ids.has(entry.id),
      'Duplicate or invalid equivalence ID',
    );
    ids.add(entry.id);
    const source = sources.get(entry.file);
    requireThat(
      typeof source === 'string' && sha256(source) === entry.sourceSha256,
      `Stale source context for ${entry.id}; re-review its proof`,
    );
    requireThat(
      originalAt(source, entry.location) === entry.original,
      `Original expression changed for ${entry.id}`,
    );
    requireThat(
      typeof entry.proof === 'string' &&
        entry.proof.trim().length >= 50 &&
        typeof entry.assumptions === 'string' &&
        entry.assumptions.trim().length >= 20,
      `Missing equivalence proof or assumptions for ${entry.id}`,
    );
    const key = exceptionKey(entry);
    requireThat(!exceptions.has(key), `Duplicate mutation exception ${entry.id}`);
    exceptions.set(key, entry);
  }
  return exceptions;
}

function validateNativeTest(test, testIds) {
  requireThat(typeof test.id === 'string' && !testIds.has(test.id), 'Duplicate or invalid test ID');
  requireThat(typeof test.name === 'string' && test.name.length > 0, 'Missing native test name');
  testIds.add(test.id);
  requireThat(
    Number.isInteger(test.location?.start?.line) &&
      test.location.start.line > 0 &&
      Number.isInteger(test.location?.start?.column) &&
      test.location.start.column > 0,
    'Missing native test locations',
  );
}

function nativeTestIds(testFiles) {
  requireThat(testFiles && Object.keys(testFiles).length > 0, 'Missing native test-file reporting');
  const testIds = new Set();
  for (const [file, record] of Object.entries(testFiles)) {
    requireThat(
      file.startsWith('tests/') &&
        !file.split('/').includes('..') &&
        typeof record.source === 'string',
      'Invalid test-file provenance',
    );
    requireThat(
      Array.isArray(record.tests) && record.tests.length > 0,
      'Missing native test locations',
    );
    for (const test of record.tests) validateNativeTest(test, testIds);
  }
  return testIds;
}

function validateMutantIdentity(file, source, mutant, mutantIds, seenFingerprints) {
  requireThat(
    typeof mutant.id === 'string' && !mutantIds.has(mutant.id),
    'Duplicate or invalid mutant ID',
  );
  mutantIds.add(mutant.id);
  requireThat(
    typeof mutant.replacement === 'string' && typeof mutant.mutatorName === 'string',
    `Malformed mutant in ${file}`,
  );
  const key = identity(file, source, mutant);
  requireThat(!seenFingerprints.has(key), `Duplicate mutation in ${file}`);
  seenFingerprints.add(key);
  return key;
}

function validTimeoutEvidence(mutant, nativeReuse) {
  return (
    (Number.isFinite(mutant.duration) && mutant.duration > 0) ||
    (nativeReuse && !Object.hasOwn(mutant, 'duration'))
  );
}

function auditMutationOutcome(file, mutant, equivalent, counts, context) {
  if (equivalent && mutant.status === 'Survived') {
    requireThat(mutant.testsCompleted > 0, `${equivalent.id} was not tested`);
    counts.equivalent++;
  } else if (mutant.status === 'Killed') {
    requireThat(
      mutant.testsCompleted > 0 &&
        mutant.killedBy?.length > 0 &&
        mutant.killedBy.every((id) => context.testIds.has(id)),
      `No failing-test evidence for killed mutant ${mutant.id}`,
    );
    counts.killed++;
  } else if (mutant.status === 'Timeout') {
    // Stryker counts timeouts as detected, not killed. Keep both visible.
    requireThat(
      validTimeoutEvidence(mutant, context.nativeReuse),
      `Invalid timeout evidence for mutant ${mutant.id}`,
    );
    counts.timedOut++;
    if (equivalent) context.timedOutEquivalents.push(equivalent.id);
  } else {
    // Includes Survived, NoCoverage, Ignored, Pending, CompileError and RuntimeError.
    throw new Error(
      `Unreviewed ${mutant.status} mutant ${file}:${mutant.location.start.line} ` +
        `${mutant.mutatorName} -> ${JSON.stringify(mutant.replacement)}`,
    );
  }
}

function auditSourceMutants(file, source, record, context) {
  requireThat(record.source === source, `Report source is stale: ${file}`);
  requireThat(!/Stryker\s+disable/.test(source), `Source-level mutation suppression: ${file}`);
  requireThat(
    Array.isArray(record.mutants) && record.mutants.length > 0,
    `No mutants generated for ${file}`,
  );
  const counts = { killed: 0, timedOut: 0, equivalent: 0, total: record.mutants.length };
  const seenFingerprints = new Set();
  for (const mutant of record.mutants) {
    const key = validateMutantIdentity(file, source, mutant, context.mutantIds, seenFingerprints);
    const equivalent = context.exceptions.get(key);
    if (equivalent) {
      requireThat(
        mutant.status === 'Survived' || mutant.status === 'Timeout',
        `${equivalent.id} has unexpected status ${mutant.status}; re-review or remove the exception`,
      );
      context.seen.add(key);
    }
    auditMutationOutcome(file, mutant, equivalent, counts, context);
  }
  return counts;
}

/**
 * Audit the unmodified raw report. No source mutation is skipped: exceptions
 * affect only the separately reported adjusted score, after every mutant has a
 * validated result. Reused results are identified separately by the wrapper;
 * native same-input reuse may omit duration; fresh timeouts require positive
 * finite duration. Only an admitted native baseline may enable this option.
 * `sources` must contain every current runtime TypeScript file under src/mp3.
 */
export function auditMutations(report, policy, sources, { nativeReuse = false } = {}) {
  validateSchemas(report, policy);
  validateMutationConfiguration(report.config);
  const paths = validateSourceInventory(Object.keys(report.files ?? {}), policy, sources);
  return auditReports([report], policy, sources, paths, nativeReuse === true);
}

const executionConfig = (config) =>
  Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'mutate'));

function validateShard(report, scope, referenceConfig, policy) {
  validateSchemas(report, policy);
  validateMutationConfiguration(report.config, scope);
  requireThat(
    report.config.concurrency === 2 && report.config.force === true,
    'Shards require fresh execution with two workers',
  );
  requireThat(
    isDeepStrictEqual(executionConfig(report.config), executionConfig(referenceConfig)),
    'Inconsistent shard execution configurations',
  );
  requireThat(
    isDeepStrictEqual(Object.keys(report.files ?? {}).sort(), scope.toSorted()),
    'Shard report does not match its assigned source files',
  );
  for (const record of Object.values(report.files))
    for (const mutant of record.mutants)
      requireThat(
        Number.isFinite(mutant.duration) && mutant.duration >= 0,
        'Shard contains a result without fresh execution evidence',
      );
}

/** Audit disjoint raw reports without merging their local mutant or test IDs. */
export function auditMutationShards(reports, policy, sources, scopes) {
  requireThat(
    Array.isArray(scopes) &&
      scopes.length > 0 &&
      scopes.every((scope) => Array.isArray(scope) && scope.length > 0),
    'Missing or empty shard scopes',
  );
  requireThat(
    Array.isArray(reports) && reports.length === scopes.length,
    'Missing or extra shard reports',
  );
  const paths = validateSourceInventory(scopes.flat(), policy, sources);
  reports.forEach((report, index) =>
    validateShard(report, scopes[index], reports[0]?.config, policy),
  );
  return auditReports(reports, policy, sources, paths, false);
}

function auditReports(reports, policy, sources, paths, nativeReuse) {
  const exceptions = reviewedExceptions(policy, sources);
  const context = {
    nativeReuse,
    exceptions,
    seen: new Set(),
    timedOutEquivalents: [],
  };
  const totals = { killed: 0, timedOut: 0, equivalent: 0, total: 0 };
  const perFile = {};
  for (const report of reports) {
    context.testIds = nativeTestIds(report.testFiles);
    context.mutantIds = new Set();
    for (const file of Object.keys(report.files).sort()) {
      const counts = auditSourceMutants(file, sources.get(file), report.files[file], context);
      perFile[file] = counts;
      for (const k of Object.keys(totals)) totals[k] += counts[k];
    }
  }
  return summarize(context, totals, perFile, paths, policy);
}

function summarize(context, totals, perFile, paths, policy) {
  const { exceptions, timedOutEquivalents } = context;
  requireThat(
    context.seen.size === exceptions.size,
    'Stale exception: its exact mutant was not generated',
  );
  const detected = totals.killed + totals.timedOut;
  // Raw counts keep Stryker's timeout outcomes. An exact reviewed equivalent
  // that timed out is excluded from both sides of the adjusted calculation;
  // it must never count as evidence that a meaningful change was detected.
  const adjustedDetected = detected - timedOutEquivalents.length;
  const adjustedTotal = totals.total - totals.equivalent - timedOutEquivalents.length;
  requireThat(
    adjustedTotal > 0 && adjustedDetected === adjustedTotal,
    'Adjusted mutation coverage is not exactly 100%',
  );
  return {
    status: 'passed',
    target: 100,
    strykerVersion: policy.strykerVersion,
    rawScore: (detected / totals.total) * 100,
    adjustedScore: 100,
    adjustedDetected,
    adjustedTotal,
    ...totals,
    perFile,
    equivalents: [...exceptions.values()].map((entry) => entry.id),
    timedOutEquivalents,
    scope: paths,
  };
}
