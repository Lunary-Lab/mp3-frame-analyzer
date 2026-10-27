import { spawn } from 'node:child_process';
import { readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const regressionOnly = process.argv.includes('--regression');
const extended = process.argv.includes('--extended');
const seconds = regressionOnly ? 0 : extended ? 120 : 8;
const timeoutMs = 2_000;
const targetNames = ['raw', 'structured', 'sequences'];
const jazzer = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'jazzer.cmd' : 'jazzer',
);
if (!existsSync(jazzer)) throw new Error('Install locked dependencies before running Jazzer.js');

async function execute(label, args, deadlineMs) {
  return new Promise((resolveDone, rejectDone) => {
    // All Jazzer invocations have both an individual-case timeout and a hard
    // process-level watchdog. The latter also handles a blocked JS event loop.
    const child = spawn(jazzer, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    let timedOut = false;
    let settled = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      console.error(`${label}: exceeded hard deadline ${deadlineMs}ms`);
      child.kill('SIGKILL');
    }, deadlineMs);
    watchdog.unref();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      rejectDone(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolveDone({ code, signal, timedOut });
    });
  });
}

for (const name of targetNames) {
  const generated = join(root, '.fuzz-corpus', name);
  const seed = join(root, 'fuzz', 'seeds', name);
  const regression = join(root, 'fuzz', 'regressions', name);
  const crash = join(root, 'fuzz', 'crashes', name);
  await Promise.all([mkdir(generated, { recursive: true }), mkdir(crash, { recursive: true })]);
  const corpus = [generated, seed, regression];
  if (name === 'raw') corpus.push(join(root, 'tests', 'fixtures'));
  const args = [
    `./fuzz/${name}.fuzz.mjs`,
    '--includes=dist/mp3/',
    `--timeout=${timeoutMs}`,
    ...(regressionOnly ? ['--mode=regression'] : []),
    ...corpus,
    '--',
    '-max_len=65536',
    '-rss_limit_mb=768',
    `-artifact_prefix=${crash}/`,
    ...(regressionOnly ? [] : [`-max_total_time=${seconds}`]),
  ];
  console.log(
    `\nJazzer.js ${name}: ${regressionOnly ? 'corpus replay' : `${seconds}s coverage-guided campaign`}`,
  );
  const result = await execute(name, args, regressionOnly ? 60_000 : (seconds + 35) * 1_000);
  if (result.code !== 0 || result.timedOut) {
    console.error(`Jazzer.js ${name} failed: exit=${result.code}, signal=${result.signal}`);
    const crashInputs = (await readdir(crash)).filter((file) => /^(crash|timeout|oom)-/.test(file));
    if (crashInputs.length > 0) {
      const { spawnSync } = await import('node:child_process');
      for (const filename of crashInputs.slice(0, 3)) {
        const command = spawnSync(
          process.execPath,
          [join(root, 'scripts', 'minimize-fuzz-crash.mjs'), name, join(crash, filename)],
          { cwd: root, stdio: 'inherit', timeout: 35_000 },
        );
        if (command.error) console.error('Fuzz minimizer:', command.error.message);
      }
    }
    process.exitCode = 1;
    break;
  }
}
