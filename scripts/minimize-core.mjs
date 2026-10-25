/**
 * Bounded ddmin of a reproducing byte sequence. Every candidate must retain
 * the same failure signature; unknown/new errors must not be substituted.
 */
export async function minimizeBytes(
  input,
  reproduces,
  { maxProbes = 200, budgetMs = 20_000 } = {},
) {
  let candidate = Buffer.from(input);
  const budget = { probes: 0, maxProbes, deadline: Date.now() + budgetMs };
  if (!(await reproduces(candidate)))
    throw new Error('Original input does not reproduce the failure');
  let parts = 2;
  while (candidate.length > 0 && budget.probes < maxProbes && Date.now() < budget.deadline) {
    const reduced = await tryRemovingPart(candidate, parts, reproduces, budget);
    if (reduced !== undefined) {
      candidate = reduced;
      parts = Math.max(2, parts - 1);
      continue;
    }
    if (parts >= candidate.length) break;
    parts = Math.min(candidate.length, parts * 2);
  }
  return { bytes: candidate, probes: budget.probes, timedOut: Date.now() >= budget.deadline };
}

/** Try each partition in order, charging the shared budget only for actual probes. */
async function tryRemovingPart(candidate, parts, reproduces, budget) {
  const sliceSize = Math.ceil(candidate.length / parts);
  for (
    let begin = 0;
    begin < candidate.length && budget.probes < budget.maxProbes && Date.now() < budget.deadline;
    begin += sliceSize
  ) {
    const end = Math.min(candidate.length, begin + sliceSize);
    const reduced = Buffer.concat([candidate.subarray(0, begin), candidate.subarray(end)]);
    budget.probes++;
    if (await reproduces(reduced)) return reduced;
  }
  return undefined;
}
