import assert from 'node:assert/strict';
import { Agent, request as httpRequest } from 'node:http';

function localUrl(base, path) {
  const url = new URL(path, base);
  assert.ok(
    url.protocol === 'http:' && url.hostname === '127.0.0.1',
    'Smoke requests must use local loopback',
  );
  assert.ok(url.port && !url.username && !url.password, 'Isolated loopback port is required');
  return url;
}

async function readResponse(response) {
  const parts = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    assert.ok(bytes <= 64 * 1024, 'Smoke response limit exceeded');
    parts.push(chunk);
  }
  const text = Buffer.concat(parts).toString('utf8');
  if (response.headers['content-length'])
    assert.equal(Number(response.headers['content-length']), bytes);
  return { status: response.statusCode, headers: response.headers, body: JSON.parse(text) };
}

function drainOrStop(request) {
  return new Promise((resolve) => {
    const done = () => {
      for (const event of ['drain', 'close', 'response', 'error']) request.off(event, done);
      resolve();
    };
    for (const event of ['drain', 'close', 'response', 'error']) request.once(event, done);
  });
}

async function writeBody(request, scenario, state) {
  try {
    for await (const chunk of scenario.body?.() ?? []) {
      if (state.responding || request.destroyed) break;
      if (!request.write(chunk)) await drainOrStop(request);
    }
    if (!request.destroyed) request.end();
  } catch (error) {
    request.destroy(error);
  }
}

export async function sendRequest(base, scenario, timeout = 30_000, agent = false) {
  const url = localUrl(base, scenario.path);
  const state = { responding: false, finished: false };
  let request;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      request = httpRequest(url, {
        method: scenario.method ?? 'POST',
        headers: scenario.headers,
        agent,
      });
      request.once('response', (response) => {
        state.responding = true;
        readResponse(response).then((result) => {
          state.finished = true;
          resolve({ ...result, reusedSocket: request.reusedSocket });
        }, reject);
      });
      request.once('error', (error) => {
        if (!state.responding) reject(error);
      });
      timer = setTimeout(() => {
        const error = new Error('Smoke request deadline exceeded');
        request.destroy(error);
        reject(error);
      }, timeout);
      void writeBody(request, scenario, state);
    });
  } finally {
    clearTimeout(timer);
    if (!state.finished) request?.destroy();
  }
}

export async function verifyKeepAlive(base, rejected, accepted) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await sendRequest(base, rejected, 30_000, agent);
    verifyResponse(first, rejected.expected, 'keep-alive rejection');
    const next = await sendRequest(base, accepted, 30_000, agent);
    verifyResponse(next, accepted.expected, 'keep-alive recovery');
    assert.equal(next.reusedSocket, true, 'Multipart rejection must leave its connection reusable');
  } finally {
    agent.destroy();
  }
}

export function verifyResponse(response, expected, label) {
  assert.equal(response.status, expected.status, `${label}: HTTP status`);
  assert.match(
    response.headers['content-type'] ?? '',
    /^application\/json(?:;|$)/,
    `${label}: JSON content type`,
  );
  if (expected.allow)
    assert.equal(response.headers.allow, expected.allow, `${label}: Allow header`);
  if (expected.status === 200) {
    assert.deepEqual(
      response.body,
      { frameCount: expected.frameCount },
      `${label}: independent count`,
    );
    return;
  }
  assert.deepEqual(
    Object.keys(response.body).sort(),
    ['error', 'message'],
    `${label}: exact error shape`,
  );
  assert.equal(response.body.error, expected.error, `${label}: typed error`);
  assert.ok(
    typeof response.body.message === 'string' && response.body.message.length > 0,
    `${label}: error message`,
  );
}
