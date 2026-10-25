import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMutations, sourceContext } from './mutation-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'reports/mutation');
const require = createRequire(import.meta.url);

async function parserSources(directory = join(root, 'src/mp3')) {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const pair of await parserSources(path)) result.set(...pair);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.set(relative(root, path).replaceAll('\\', '/'), await readFile(path, 'utf8'));
    }
  }
  return result;
}

function runStryker() {
  return new Promise((resolve, reject) => {
    const cli = join(
      dirname(require.resolve('@stryker-mutator/core/package.json')),
      'bin/stryker.js',
    );
    const child = spawn(process.execPath, [cli, 'run'], {
      cwd: root,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: { ...process.env, PROPERTY_SEED: '20261024' },
    });
    let interrupted = null;
    function stop(reason = 'wall-clock limit') {
      interrupted = reason;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      } else child.kill('SIGKILL');
    }
    // Per-mutant timeouts are in stryker.config.json; this bounds the whole run.
    // CI projected about 45 minutes for the full corpus; retain finite headroom.
    const onInterrupt = () => stop('SIGINT');
    const onTerminate = () => stop('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const timer = setTimeout(stop, 60 * 60 * 1000);
    function cleanup() {
      clearTimeout(timer);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    }
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (interrupted || signal || code !== 0) {
        reject(
          new Error(
            `Stryker did not complete cleanly: code=${code}, signal=${signal}, interrupted=${interrupted}`,
          ),
        );
      } else resolve();
    });
  });
}

try {
  // A stale successful report must never authorize a new run.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const policy = JSON.parse(await readFile(join(root, 'mutation-equivalents.json'), 'utf8'));
  if (policy.contextSha256 !== sourceContext(await parserSources())) {
    throw new Error('Parser context changed: review equivalence proofs before rerunning mutations');
  }
  await runStryker();
  const report = JSON.parse(await readFile(join(output, 'mutation.json'), 'utf8'));
  const summary = auditMutations(report, policy, await parserSources());
  await writeFile(join(output, 'audit.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Raw mutation score: ${summary.rawScore.toFixed(2)}%`);
  console.log(
    `Adjusted mutation score: ${summary.adjustedScore}% ` +
      `(${summary.adjustedDetected}/${summary.adjustedTotal}; required: 100%)`,
  );
  console.log(
    `Killed: ${summary.killed}; timed out: ${summary.timedOut}; ` +
      `reviewed equivalent survivors: ${summary.equivalent}.`,
  );
  console.log(
    `Reviewed equivalent timeouts: ${summary.timedOutEquivalents.length}` +
      (summary.timedOutEquivalents.length ? ` (${summary.timedOutEquivalents.join(', ')})` : '') +
      '.',
  );
  console.log('Every parser module is included. Raw report: reports/mutation/mutation.json');
} catch (error) {
  console.error(`Mutation verification FAILED: ${error.message}`);
  process.exitCode = 1;
}
