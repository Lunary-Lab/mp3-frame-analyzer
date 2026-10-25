/**
 * Fail closed if isolated replay fails for an infrastructure reason. A status
 * 127 shell failure or missing runtime is not a reproducible parser crash.
 */
export function classifyReplayProcess(proc) {
  if (proc.error?.code === 'ETIMEDOUT') return 'timeout';
  if (proc.error) {
    throw new Error(`Fuzz replay could not launch: ${proc.error.message}`, {
      cause: proc.error,
    });
  }
  if (proc.status === 0) return null;

  const match = proc.stderr?.match(/^FUZZ_FAILURE (\{[^\n]+\})$/m);
  if (!match) {
    throw new Error(
      `Fuzz replay exited without a recognized failure marker: exit=${String(proc.status)}, ` +
        `signal=${String(proc.signal)}`,
    );
  }
  return parseFailureMarker(match[1]);
}

function parseFailureMarker(marker) {
  let parsed;
  try {
    parsed = JSON.parse(marker);
  } catch (error) {
    throw new Error('Fuzz replay produced an invalid failure marker', {
      cause: error,
    });
  }
  if (
    typeof parsed?.name !== 'string' ||
    parsed.name.length === 0 ||
    typeof parsed.family !== 'string' ||
    parsed.family.length === 0
  ) {
    throw new Error('Fuzz replay produced an incomplete failure marker');
  }
  return `${parsed.name}:${parsed.family}`;
}
