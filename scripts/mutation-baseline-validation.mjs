import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditMutations } from './mutation-policy.mjs';
import { mutationEnvironment, mutationInputs, validateCache } from './mutation-cache.mjs';
import { changedInputPaths, reuseContext } from './mutation-compatibility.mjs';
import { planReuse } from './mutation-impact.mjs';

// The current snapshot is captured once, not once per downloaded candidate.
// run-mutations independently captures and validates it again before execution.
export async function candidateValidator(root) {
  const inputs = await mutationInputs(root, mutationEnvironment());
  const policy = JSON.parse(await readFile(join(root, 'mutation-equivalents.json'), 'utf8'));
  return baselineValidator(inputs, policy);
}

export function baselineValidator(inputs, policy) {
  const current = reuseContext(inputs);
  return ({ manifest, reportText }) => {
    const report = validateCache(manifest, reportText, inputs, auditMutations, policy);
    const baseline = reuseContext(manifest.inputs);
    const prepared = planReuse(report, current.files, {
      baselineFiles: baseline.files,
      baselineInputs: manifest.inputs.files,
      currentInputs: inputs.files,
      baselineTestFiles: baseline.testFiles,
      testFiles: current.testFiles,
      changedInputs: changedInputPaths(manifest.inputs, inputs),
    });
    return Boolean(prepared.report && prepared.eligible > 0);
  };
}
