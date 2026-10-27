import { BaseSequencer } from 'vitest/node';

// Stryker bails after a killing test. Use Vitest's existing duration cache to
// try cheaper files first, without changing which test specifications run.
export default class MutationFastFirstSequencer extends BaseSequencer {
  async sort(files) {
    const durations = new Map(
      files.map((file) => [file, this.ctx.cache.getTestSpecificationResult(file)?.duration]),
    );
    return [...files].sort(
      (a, b) =>
        (durations.get(a) ?? Number.MAX_VALUE) - (durations.get(b) ?? Number.MAX_VALUE) ||
        a.moduleId.localeCompare(b.moduleId),
    );
  }
}
