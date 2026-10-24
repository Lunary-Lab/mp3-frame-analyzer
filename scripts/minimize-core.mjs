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
  let probes = 0;
  const deadline = Date.now() + budgetMs;
  if (!(await reproduces(candidate)))
    throw new Error("Original input does not reproduce the failure");
  let parts = 2;
  while (candidate.length > 0 && probes < maxProbes && Date.now() < deadline) {
    const sliceSize = Math.ceil(candidate.length / parts);
    let shrunk = false;
    for (
      let begin = 0;
      begin < candidate.length && probes < maxProbes && Date.now() < deadline;
      begin += sliceSize
    ) {
      const end = Math.min(candidate.length, begin + sliceSize);
      const reduced = Buffer.concat([
        candidate.subarray(0, begin),
        candidate.subarray(end),
      ]);
      probes++;
      if (await reproduces(reduced)) {
        candidate = reduced;
        parts = Math.max(2, parts - 1);
        shrunk = true;
        break;
      }
    }
    if (shrunk) continue;
    if (parts >= candidate.length) break;
    parts = Math.min(candidate.length, parts * 2);
  }
  return { bytes: candidate, probes, timedOut: Date.now() >= deadline };
}
