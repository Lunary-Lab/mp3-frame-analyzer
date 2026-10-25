import { createHash } from 'node:crypto';

export const PARSER_GLOB = 'src/mp3/**/*.ts';
export const VITEST_CONFIG = 'vitest.mutation.config.ts';
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const sourceContext = (sources) =>
  sha256(
    JSON.stringify([...sources.keys()].sort().map((file) => [file, sha256(sources.get(file))])),
  );

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

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

function validateSchemas(report, policy) {
  requireThat(policy?.schemaVersion === 1, 'Unsupported equivalence-policy schema');
  requireThat(policy.target === 100, 'The adjusted mutation gate must remain 100%');
  requireThat(report?.schemaVersion === '1.0', 'Unsupported Stryker report schema');
  requireThat(
    report.framework?.name === 'StrykerJS' && report.framework.version === policy.strykerVersion,
    'Stryker version changed: review the mutation policy',
  );
}

function validateExecutionConfiguration(config) {
  requireThat(
    config.testRunner === 'vitest' &&
      config.vitest?.configFile === VITEST_CONFIG &&
      config.vitest?.related === false &&
      config.vitest?.pool === 'forks' &&
      config.coverageAnalysis === 'perTest' &&
      config.incremental === true &&
      config.incrementalFile === '.cache/mutation/working.json',
    'Unexpected mutation execution configuration',
  );
}

function validateMutationConfiguration(config) {
  requireThat(
    JSON.stringify(config?.mutate) === JSON.stringify([PARSER_GLOB]),
    'Mutation scope must include the entire parser',
  );
  validateExecutionConfiguration(config);
  requireThat(
    !config.mutator?.excludedMutations?.length && !config.ignorers?.length,
    'Broad mutation exclusions are forbidden',
  );
}

function validateSourceInventory(report, policy, sources) {
  requireThat(sources instanceof Map && sources.size > 0, 'Empty parser source inventory');
  const paths = [...sources.keys()].sort();
  requireThat(
    report.files && JSON.stringify(Object.keys(report.files).sort()) === JSON.stringify(paths),
    'Mutation report does not contain every current parser source',
  );
  requireThat(
    policy.contextSha256 === sourceContext(sources),
    'Parser context changed: re-review equivalence proofs before updating the context hash',
  );
  return paths;
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
      Number.isFinite(mutant.duration) && mutant.duration > 0,
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
 * a timeout always requires fresh positive duration evidence.
 * `sources` must contain every current runtime TypeScript file under src/mp3.
 */
export function auditMutations(report, policy, sources) {
  validateSchemas(report, policy);
  validateMutationConfiguration(report.config);
  const paths = validateSourceInventory(report, policy, sources);
  const exceptions = reviewedExceptions(policy, sources);
  const testIds = nativeTestIds(report.testFiles);
  const context = {
    exceptions,
    testIds,
    seen: new Set(),
    mutantIds: new Set(),
    timedOutEquivalents: [],
  };
  const totals = { killed: 0, timedOut: 0, equivalent: 0, total: 0 };
  const perFile = {};
  for (const file of paths) {
    const counts = auditSourceMutants(file, sources.get(file), report.files[file], context);
    perFile[file] = counts;
    for (const k of Object.keys(totals)) totals[k] += counts[k];
  }
  requireThat(
    context.seen.size === exceptions.size,
    'Stale exception: its exact mutant was not generated',
  );
  const { timedOutEquivalents } = context;
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
