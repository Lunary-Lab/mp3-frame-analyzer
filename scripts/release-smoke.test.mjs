import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  buildScenarios,
  frameStream,
  multipartStream,
  uploadLimit,
} from './release-smoke-cases.mjs';
import { sendRequest, verifyResponse } from './release-smoke-http.mjs';
import { decodeFixtureManifest, loadSmokeFixtures } from './release-smoke-fixtures.mjs';
import { createHash } from 'node:crypto';

const fixture = { name: 'cbr', bytes: Buffer.from([1, 2, 3]), audioFrames: 32, physicalFrames: 33 };
const noHeader = { ...fixture, name: 'no-xing', audioFrames: 51, physicalFrames: 51 };
const response = (overrides = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: { frameCount: 32 },
  ...overrides,
});

test('scenario matrix preserves raw/multipart and omitted/false/true independent counts', () => {
  const scenarios = buildScenarios([fixture, noHeader]);
  for (const item of [fixture, noHeader]) {
    for (const form of ['raw', 'multipart']) {
      for (const policy of ['default', 'false', 'true']) {
        const found = scenarios.find(
          (scenario) => scenario.id === `${item.name}/${form}/${policy}`,
        );
        assert.ok(found);
        assert.equal(
          found.expected.frameCount,
          policy === 'true' ? item.physicalFrames : item.audioFrames,
        );
      }
    }
  }
  for (const id of [
    'raw/empty',
    'multipart/empty',
    'raw/malformed',
    'multipart/malformed',
    'raw/unsupported',
    'multipart/unsupported',
    'multipart/missing',
    'multipart/wrong-field',
    'multipart/multiple-files',
    'multipart/text-field',
    'multipart/incomplete',
    'raw/declared-limit',
    'raw/chunked-limit',
    'multipart/file-limit',
    'method-not-allowed',
    'not-found',
  ])
    assert.ok(
      scenarios.some((scenario) => scenario.id === id),
      id,
    );
});

test('upload-limit source stays bounded and counts frames without using production parser', async () => {
  let bytes = 0;
  let largest = 0;
  for await (const chunk of frameStream(1000)) {
    bytes += chunk.length;
    largest = Math.max(largest, chunk.length);
    assert.equal(chunk[0], 0xff);
    assert.equal(chunk[1], 0xfb);
  }
  assert.equal(bytes, 1000 * 417);
  assert.ok(largest <= 64 * 1024);
  assert.equal(uploadLimit, 50 * 1024 * 1024);
  assert.throws(() => frameStream(-1), /frame count/);
});

test('genuine free-format smoke retains in-scope counts and rejects higher-rate extensions', async () => {
  const fixtures = await loadSmokeFixtures();
  assert.equal(fixtures.length, 8);
  const scenarios = buildScenarios(fixtures);
  const extensions = new Set(['free-format-44100-1-400-false', 'free-format-32000-1-400-true']);
  for (const item of fixtures) {
    for (const form of ['raw', 'multipart']) {
      for (const policy of ['default', 'false', 'true']) {
        const found = scenarios.find(
          (scenario) => scenario.id === `${item.name}/${form}/${policy}`,
        );
        assert.ok(found);
        assert.deepEqual(
          found.expected,
          extensions.has(item.name)
            ? { status: 415, error: 'unsupported-format' }
            : {
                status: 200,
                frameCount: policy === 'true' ? item.physicalFrames : item.audioFrames,
              },
          found.id,
        );
      }
    }
  }
});

test('multipart generator places body bytes between complete deterministic boundaries', async () => {
  const parts = [];
  for await (const part of multipartStream([Buffer.from('abc')])) parts.push(part);
  const body = Buffer.concat(parts).toString();
  assert.match(body, /name="file"; filename="smoke.mp3"/);
  assert.match(body, /Content-Type: audio\/mpeg\r\n\r\nabc\r\n--release-smoke-boundary--\r\n$/);
});

test('response gate requires exact count, typed JSON errors, headers and sanitized shape', () => {
  verifyResponse(response(), { status: 200, frameCount: 32 }, 'good');
  for (const change of [
    { status: 201 },
    { headers: { 'content-type': 'text/plain' } },
    { body: { frameCount: 33 } },
    { body: { frameCount: 32, extra: true } },
  ])
    assert.throws(() => verifyResponse(response(change), { status: 200, frameCount: 32 }, 'bad'));
  const error = response({ status: 422, body: { error: 'invalid-mp3', message: 'Invalid data' } });
  verifyResponse(error, { status: 422, error: 'invalid-mp3' }, 'reject');
  assert.throws(() =>
    verifyResponse(error, { status: 415, error: 'unsupported-format' }, 'wrong type'),
  );
  assert.throws(() =>
    verifyResponse(
      { ...error, body: { ...error.body, stack: 'private' } },
      { status: 422, error: 'invalid-mp3' },
      'leak',
    ),
  );
});

test('genuine fixture manifest requires exact bytes and bounded independent counts', () => {
  const bytes = Buffer.from('benign fixture');
  const record = {
    name: 'reviewed',
    bitrate: 128,
    bytes: bytes.length,
    audioFrames: 2,
    physicalFrames: 3,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  const manifest = { schemaVersion: 1, encoder: 'LAME 3.100', records: [record] };
  assert.equal(decodeFixtureManifest(manifest)[0].physicalFrames, 3);
  for (const patch of [
    { sha256: 'bad' },
    { bytes: 1 },
    { audioFrames: 0 },
    { physicalFrames: 99 },
    { bitrate: 0 },
    { bitrate: '400' },
  ]) {
    assert.throws(() => decodeFixtureManifest({ ...manifest, records: [{ ...record, ...patch }] }));
  }
});

test('HTTP helper refuses non-loopback and bounds response size and request deadlines', async () => {
  await assert.rejects(sendRequest('https://example.com', { path: '/', expected: {} }), /loopback/);
  const server = createServer((request, reply) => {
    if (request.url === '/large') reply.end(Buffer.alloc(70_000));
    else if (request.url === '/wait') return;
    else reply.writeHead(200, { 'content-type': 'application/json' }).end('{"frameCount":32}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await sendRequest(base, { method: 'GET', path: '/' })).body.frameCount, 32);
    await assert.rejects(sendRequest(base, { method: 'GET', path: '/large' }), /response limit/);
    await assert.rejects(sendRequest(base, { method: 'GET', path: '/wait' }, 30), /deadline/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
