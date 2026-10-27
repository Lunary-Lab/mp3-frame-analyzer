import { spawn } from 'node:child_process';
import { repositoryRoot as root } from './release-utils.mjs';

export function runMutationProcess(cli, args, env, log, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env,
    });
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      log.write(data);
    });
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      log.write(data);
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
    // Per-mutant timeouts are in stryker.config.json. This 90-minute deadline
    // bounds each child process, including the complete Stryker campaign.
    const onInterrupt = () => stop('SIGINT');
    const onTerminate = () => stop('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const timer = setTimeout(stop, 90 * 60 * 1000);
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
            `Test process did not complete cleanly: code=${code}, signal=${signal}, interrupted=${interrupted}`,
          ),
        );
      } else resolve();
    });
  });
}
