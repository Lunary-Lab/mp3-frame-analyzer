import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const pureSources = ['src/client-error.ts', 'src/error-response.ts', 'src/server-config.ts'];
// Mirror source names rather than maintain a second independent test-file list.
export const pureTests = pureSources.map((file) =>
  file.replace(/^src\//, 'tests/').replace(/\.ts$/, '.test.ts'),
);

// Deferred means NOT mutation-enforced by this campaign, not an equivalence waiver.
export const deferredSources = {
  'src/app.ts': 'HTTP route and framework integration',
  'src/logging.ts': 'Logger serialization',
  'src/multipart-budget.ts': 'Streaming budget and backpressure',
  'src/server.ts': 'Bootstrap and real-process lifecycle',
  'src/shutdown.ts': 'Deadline and shutdown lifecycle',
  'src/upload-admission.ts': 'Concurrent admission and transport lifecycle',
  'src/upload-cancellation.ts': 'HTTP transport cancellation lifecycle',
  'src/upload-work.ts': 'Asynchronous work ownership',
  'src/upload.ts': 'Raw and multipart upload lifecycle',
};

async function sourcesBelow(root, directory) {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const file = posix.join(directory, entry.name);
    if (file === 'src/mp3') continue;
    assert.ok(!entry.isSymbolicLink(), `Unsupported source symlink: ${file}`);
    if (entry.isDirectory()) files.push(...(await sourcesBelow(root, file)));
    else if (entry.isFile() && file.endsWith('.ts')) files.push(file);
  }
  return files.sort();
}

/** A new runtime module needs a conscious stage assignment, not silent omission. */
export async function assertPureScope(root) {
  assert.deepEqual(
    await sourcesBelow(root, 'src'),
    [...pureSources, ...Object.keys(deferredSources)].sort(),
    'Nonparser source inventory changed; review the active/deferred stage assignment',
  );
}

/** Native scores exclude some error statuses; this small stage requires actual kills. */
export function assertPureReport(report) {
  assert.ok(report && typeof report === 'object' && !Array.isArray(report), 'Malformed report');
  assert.ok(report.files && typeof report.files === 'object' && !Array.isArray(report.files));
  assert.deepEqual(
    Object.keys(report.files).sort(),
    [...pureSources].sort(),
    'Unexpected source inventory',
  );
  let killed = 0;
  for (const [file, result] of Object.entries(report.files)) {
    assert.ok(Array.isArray(result.mutants) && result.mutants.length > 0, `No mutants: ${file}`);
    for (const mutant of result.mutants) {
      assert.equal(mutant.status, 'Killed', `${file}: ${mutant.id} was ${mutant.status}`);
      killed++;
    }
  }
  return killed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(`Pure runtime mutation: ${assertPureReport(report)} mutants killed; no exemptions`);
}
