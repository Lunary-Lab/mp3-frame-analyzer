import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  audioChunks,
  BYTES_PER_SEGMENT,
  FRAMES_PER_SEGMENT,
  repetitionsForMiB,
} from './performance-fixture.mjs';

// Keep the client and server in separate processes. Client-side generation and
// parsing must not be mistaken for server event-loop latency. No external URL
// is accepted: this bounded measurement always owns a local ephemeral server.
const child = fork(fileURLToPath(new URL('./http-performance-server.mjs', import.meta.url)), {
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
const messages = [];
child.on('message', (message) => messages.push(message));
const exit = once(child, 'exit');

async function waitForMessage(type) {
  for (;;) {
    const found = messages.find((message) => message.type === type);
    if (found) return found;
    assert.equal(child.exitCode, null, `Benchmark server exited before ${type}`);
    assert.equal(child.signalCode, null, `Benchmark server was terminated before ${type}`);
    await Promise.race([once(child, 'message'), exit]);
  }
}

async function upload(baseUrl, repetitions) {
  const endpoint = new URL('/file-upload', baseUrl);
  assert.equal(endpoint.hostname, '127.0.0.1');
  const boundary = 'mp3-performance-boundary';
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const started = performance.now();
  const req = request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': prefix.length + repetitions * BYTES_PER_SEGMENT + suffix.length,
    },
    timeout: 15_000,
  });
  req.once('timeout', () => req.destroy(new Error('Local upload benchmark timed out')));
  const response = (async () => {
    const [res] = await once(req, 'response');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of res) {
      bytes += chunk.length;
      assert.ok(bytes <= 8192, 'Unexpectedly large response');
      chunks.push(chunk);
    }
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /^application\/json\b/);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      frameCount: repetitions * FRAMES_PER_SEGMENT,
    });
    return { elapsedMs: performance.now() - started, bytes: repetitions * BYTES_PER_SEGMENT };
  })();
  const send = (async () => {
    if (!req.write(prefix)) await once(req, 'drain');
    for await (const chunk of audioChunks(repetitions)) {
      if (!req.write(chunk)) await once(req, 'drain');
    }
    req.end(suffix);
  })();
  try {
    const [result] = await Promise.all([response, send]);
    return result;
  } catch (error) {
    req.destroy();
    throw error;
  }
}

try {
  const { address } = await waitForMessage('ready');
  await upload(address, 1); // Warm routing/serialization before measurement.
  child.send('measure');
  await waitForMessage('measuring');
  let active = 2;
  const repetitions = repetitionsForMiB(32);
  const started = performance.now();
  const large = Promise.all(
    Array.from({ length: active }, () => upload(address, repetitions).finally(() => active--)),
  );
  // Attach a rejection handler immediately while the probe loop is running.
  let failure;
  void large.catch((error) => {
    failure = error;
  });
  const probes = [];
  do {
    probes.push(await upload(address, 1));
    if (active > 0) await delay(10);
  } while (active > 0 && failure === undefined);
  const uploads = await large;
  const elapsedMs = performance.now() - started;
  child.send('stop');
  const server = await waitForMessage('metrics');
  const [code, signal] = await exit;
  assert.equal(code, 0, `Benchmark server terminated: ${signal ?? code}`);
  const latencies = probes.map((probe) => probe.elapsedMs).sort((a, b) => a - b);
  const percentile = (fraction) => latencies[Math.ceil(latencies.length * fraction) - 1];
  console.log(
    JSON.stringify(
      {
        kind: 'local-http-concurrency',
        node: process.version,
        largeUploadConcurrency: uploads.length,
        elapsedMs,
        largeUploads: uploads,
        probeUploads: {
          count: probes.length,
          bytesEach: BYTES_PER_SEGMENT,
          medianMs: percentile(0.5),
          p95Ms: percentile(0.95),
          maxMs: latencies[latencies.length - 1],
        },
        server,
        note:
          'Correct counts and successful completion are required. ' +
          'Timing is a small local sample, not a shared-CI latency SLA or a statistical capacity estimate.',
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(deadline);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
