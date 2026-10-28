import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const PARSER_GLOB = 'src/mp3/**/*.ts';
export const VITEST_CONFIG = 'vitest.mutation.config.ts';
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const sourceContext = (sources) =>
  sha256(
    JSON.stringify([...sources.keys()].sort().map((file) => [file, sha256(sources.get(file))])),
  );

export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateSchemas(report, policy) {
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

export function validateMutationConfiguration(config, scope = [PARSER_GLOB]) {
  requireThat(
    JSON.stringify(config?.mutate) === JSON.stringify(scope),
    'Mutation scope must include the entire parser',
  );
  validateExecutionConfiguration(config);
  requireThat(
    !config.mutator?.excludedMutations?.length && !config.ignorers?.length,
    'Broad mutation exclusions are forbidden',
  );
}

export function validateSourceInventory(inventory, policy, sources) {
  requireThat(sources instanceof Map && sources.size > 0, 'Empty parser source inventory');
  const paths = [...sources.keys()].sort();
  requireThat(
    JSON.stringify(inventory.toSorted()) === JSON.stringify(paths),
    'Mutation report does not contain every current parser source',
  );
  requireThat(
    policy.contextSha256 === sourceContext(sources),
    'Parser context changed: re-review equivalence proofs before updating the context hash',
  );
  return paths;
}

export function validatePartitionInventory(reports, inventories) {
  requireThat(inventories.length === reports.length, 'Missing native partition inventory');
  const key = (file, { location: { start, end }, mutatorName, replacement }) =>
    JSON.stringify([
      file,
      start.line,
      start.column,
      end.line,
      end.column,
      mutatorName,
      replacement,
    ]);
  const seen = new Set();
  for (const [index, expected] of inventories.entries()) {
    const expectedKeys = expected.map(({ fileName, ...mutant }) => key(fileName, mutant));
    for (const identity of expectedKeys) {
      requireThat(!seen.has(identity), 'Duplicate native partition ownership');
      seen.add(identity);
    }
    const actual = Object.entries(reports[index].files).flatMap(([file, record]) =>
      record.mutants.map((mutant) => key(file, mutant)),
    );
    requireThat(
      isDeepStrictEqual(actual.sort(), expectedKeys.sort()),
      'Missing, extra or duplicate native partition mutant',
    );
  }
}
