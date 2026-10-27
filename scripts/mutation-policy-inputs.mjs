import { createHash } from 'node:crypto';

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
