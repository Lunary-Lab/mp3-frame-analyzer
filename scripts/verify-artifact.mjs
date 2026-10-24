import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadVersionMetadata } from './verify-version.mjs';
import {
  isMain,
  parseChecksums,
  readJson,
  releaseNames,
  repositoryRoot,
  runFile,
  runNpm,
  sha256,
  validateArchiveEntries,
} from './release-utils.mjs';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function deadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function smokeRuntime(runtime) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: runtime,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited = false;
  const capture = (data) => {
    output = `${output}${data}`.slice(-16_384);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      exited = true;
      output += error.message;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  // The startup loop reports early exits with logs; handle rejection until that point.
  void completion.catch(() => {});
  try {
    const until = Date.now() + 10_000;
    for (;;) {
      if (exited) throw new Error(`Packaged server exited during startup:\n${output}`);
      try {
        const probe = await fetch(baseUrl, { signal: AbortSignal.timeout(500) });
        await probe.arrayBuffer();
        break;
      } catch {
        if (Date.now() >= until)
          throw new Error(`Packaged server did not become ready:\n${output}`);
        await delay(50);
      }
    }
    const fixture = await readFile(join(repositoryRoot, 'tests/fixtures/cbr.mp3'));
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'audio/mpeg' }), 'release-smoke.mp3');
    const response = await fetch(`${baseUrl}/file-upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `Packaged upload returned HTTP ${response.status}`);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/);
    assert.deepEqual(await response.json(), { frameCount: 33 });
    assert.equal(exited, false, 'Packaged server exited before shutdown');
    assert.equal(child.kill('SIGTERM'), true, 'Could not send SIGTERM to packaged server');
    const shutdown = await deadline(
      completion,
      15_000,
      'Packaged server did not stop after SIGTERM',
    );
    assert.deepEqual(shutdown, { code: 0, signal: null }, `Unclean shutdown:\n${output}`);
    return { frameCount: 33, shutdownExitCode: shutdown.code };
  } finally {
    if (!exited) {
      child.kill('SIGKILL');
      await deadline(completion, 5000, 'Could not stop packaged server');
    }
  }
}

export async function verifyArtifact() {
  const expected = await loadVersionMetadata();
  const names = releaseNames(expected.version);
  const output = join(repositoryRoot, 'release');
  const files = [names.archive, names.sbom, names.manifest];
  const checksums = parseChecksums(await readFile(join(output, 'SHA256SUMS'), 'utf8'), files);
  for (const name of files) {
    assert.equal(
      await sha256(join(output, name)),
      checksums.get(name),
      `Checksum mismatch: ${name}`,
    );
  }
  const metadata = await readJson(join(output, names.manifest));
  for (const key of ['name', 'version', 'tag', 'sourceCommit']) {
    assert.equal(metadata[key], expected[key], `Release manifest ${key} mismatch`);
  }
  const archive = join(output, names.archive);
  const listing = await runFile('tar', ['-tzf', archive]);
  validateArchiveEntries(listing.stdout.trimEnd().split('\n'), names.base);
  const verbose = await runFile('tar', ['-tvzf', archive]);
  assert.ok(
    verbose.stdout
      .trimEnd()
      .split('\n')
      .every((line) => /^[d-]/.test(line)),
    'Archive must contain only regular files and directories',
  );

  const temporary = await mkdtemp(join(tmpdir(), 'mp3-release-smoke-'));
  try {
    await runFile('tar', [
      '-xzf',
      archive,
      '-C',
      temporary,
      '--no-same-owner',
      '--no-same-permissions',
    ]);
    const runtime = join(temporary, names.base);
    assert.deepEqual(await readJson(join(runtime, 'release-metadata.json')), metadata);
    const pkg = await readJson(join(runtime, 'package.json'));
    const lock = await readJson(join(runtime, 'package-lock.json'));
    assert.equal(pkg.version, expected.version);
    assert.equal(lock.version, expected.version);
    assert.equal(lock.packages[''].version, expected.version);
    await runNpm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: runtime,
      timeout: 180_000,
    });
    const result = await smokeRuntime(runtime);
    console.log(
      JSON.stringify(
        { artifact: names.archive, ...metadata, verifiedWithNode: process.version, ...result },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) await verifyArtifact();
