import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimizeBytes } from './minimize-core.mjs';
import { classifyReplayProcess } from './classify-replay.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const [target, inputFile] = process.argv.slice(2);
if (!['raw', 'structured', 'sequences'].includes(target) || !inputFile) {
  throw new Error(
    'Usage: node scripts/minimize-fuzz-crash.mjs <raw|structured|sequences> <crash-file>',
  );
}
const original = await readFile(inputFile);
const run = (bytes) => {
  const proc = spawnSync(process.execPath, ['scripts/run-fuzz-case.mjs', target], {
    cwd: root,
    input: bytes,
    encoding: 'utf8',
    timeout: 1200,
    maxBuffer: 128 * 1024,
  });
  return classifyReplayProcess(proc);
};
const expectedSignature = run(original);
if (!expectedSignature)
  throw new Error(
    'Crash does not reproduce without instrumentation; preserve original artifact for investigation',
  );
const result = await minimizeBytes(original, (bytes) => run(bytes) === expectedSignature, {
  maxProbes: 180,
  budgetMs: 22_000,
});
const hash = createHash('sha256').update(result.bytes).digest('hex').slice(0, 16);
const dir = join(root, 'fuzz', 'crashes', target);
await mkdir(dir, { recursive: true });
const destination = join(dir, `minimized-${hash}.bin`);
await writeFile(destination, result.bytes);
console.log(
  JSON.stringify({
    target,
    originalBytes: original.length,
    minimizedBytes: result.bytes.length,
    probes: result.probes,
    budgetExceeded: result.timedOut,
    failureSignature: expectedSignature,
    savedAs: destination,
    note: 'Review minimized crash before promoting to tracked fuzz/regressions.',
  }),
);
