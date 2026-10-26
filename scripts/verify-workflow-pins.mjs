import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workflowPinControls } from './workflow-pin-controls.mjs';
import { auditWorkflowPins } from './workflow-pins.mjs';

assert.equal(process.argv.length, 3, 'Expected the verified zizmor executable path');
const binary = resolve(process.argv[2]);
assert.equal(
  execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
  'zizmor 1.31.1',
);
const cache = await mkdtemp(join(tmpdir(), 'mp3-zizmor-cache-'));
try {
  await workflowPinControls(binary, cache);
  const summary = await auditWorkflowPins(binary, process.cwd(), cache);
  console.log(JSON.stringify({ ...summary, nativeControls: true, accepted: true }));
} finally {
  await rm(cache, { recursive: true, force: true });
}
