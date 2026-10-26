import { arch, availableParallelism, cpus, freemem, platform, totalmem } from 'node:os';

// Numeric concurrency is passed directly to Stryker. With no checkers, its
// concurrency-token provider creates exactly this many test runner processes.
function validateConfig(config) {
  if (![1, 2].includes(config.concurrency) || (config.checkers?.length ?? 0) !== 0)
    throw new Error('Mutation worker selection requires a safe 1/2-worker config without checkers');
}

export function mutationWorkers(config, requested, available = availableParallelism()) {
  validateConfig(config);
  if (!Number.isSafeInteger(available) || available < 1)
    throw new Error('Cannot establish available mutation parallelism');
  if (requested !== undefined && !['1', '2', '4'].includes(requested))
    throw new Error('MUTATION_WORKERS must be exactly 1, 2 or 4');
  const workers =
    requested === undefined ? Math.min(config.concurrency, available) : Number(requested);
  if (workers > available)
    throw new Error('Requested mutation workers exceed available CPU parallelism');
  return workers;
}

export function mutationHardware(workers) {
  return {
    strykerWorkers: workers,
    availableParallelism: availableParallelism(),
    logicalCpuCount: cpus().length,
    architecture: arch(),
    platform: platform(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    availableMemoryBytesAtStart: process.availableMemory(),
    // Node returns zero when no constraint is known, not a zero-byte limit.
    constrainedMemoryBytes: process.constrainedMemory() || null,
    workerPeakRssBytes: null,
    workerCpuUtilization: null,
    resourceMeasurement: 'capacity snapshot only; worker RSS and CPU utilization not collected',
  };
}
