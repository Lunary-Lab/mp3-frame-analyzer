import assert from 'node:assert/strict';

export const uploadLimit = 50 * 1024 * 1024;
const boundary = 'release-smoke-boundary';
const multipartType = `multipart/form-data; boundary=${boundary}`;
const success = (frameCount) => ({ status: 200, frameCount });
const failure = (status, error) => ({ status, error });

export function frameStream(frames) {
  assert.ok(Number.isSafeInteger(frames) && frames > 0, 'Positive safe frame count is required');
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]); // MPEG-1 Layer III, 128 kbps/44.1 kHz; no metadata frame.
  const block = Buffer.concat(Array.from({ length: 128 }, () => frame));
  return (function* () {
    for (let sent = 0; sent < frames; sent += 128) {
      yield block.subarray(0, Math.min(128, frames - sent) * frame.length);
    }
  })();
}

export async function* multipartStream(chunks, { field = 'file', mime = 'audio/mpeg' } = {}) {
  yield Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="smoke.mp3"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  for await (const chunk of chunks) yield chunk;
  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

function raw(id, bytes, expected, path = '/file-upload', mime = 'audio/mpeg') {
  return {
    id,
    method: 'POST',
    path,
    expected,
    body: () => [bytes],
    headers: { 'content-type': mime, 'content-length': String(bytes.length) },
  };
}

function multipart(id, bytes, expected, path = '/file-upload', options = {}) {
  return {
    id,
    method: 'POST',
    path,
    expected,
    body: () => multipartStream([bytes], options),
    headers: { 'content-type': multipartType },
  };
}

function fixtureUploads(fixtures) {
  const cases = [];
  for (const fixture of fixtures) {
    for (const [form, create] of [
      ['raw', raw],
      ['multipart', multipart],
    ]) {
      for (const policy of ['default', 'false', 'true']) {
        const query = policy === 'default' ? '' : `?includeVbrHeaderFrame=${policy}`;
        // Preserve the genuine higher-rate LAME bytes as explicit rejection controls.
        const expected =
          fixture.bitrate > 320
            ? failure(415, 'unsupported-format')
            : success(policy === 'true' ? fixture.physicalFrames : fixture.audioFrames);
        cases.push(
          create(
            `${fixture.name}/${form}/${policy}`,
            fixture.bytes,
            expected,
            `/file-upload${query}`,
          ),
        );
      }
    }
  }
  return cases;
}

function malformedUploads(fixture) {
  const cases = [];
  const unsupported = Buffer.alloc(417);
  unsupported.set([0xff, 0xf3, 0x90, 0x00]); // Deliberately unsupported MPEG-2, not an exploit payload.
  for (const [form, create] of [
    ['raw', raw],
    ['multipart', multipart],
  ]) {
    cases.push(create(`${form}/empty`, Buffer.alloc(0), failure(400, 'empty-file')));
    cases.push(
      create(`${form}/malformed`, Buffer.from('not mp3 data'), failure(422, 'invalid-mp3')),
    );
    cases.push(create(`${form}/unsupported`, unsupported, failure(415, 'unsupported-format')));
    cases.push(
      create(
        `${form}/invalid-option`,
        fixture.bytes,
        failure(400, 'invalid-option'),
        '/file-upload?includeVbrHeaderFrame=maybe',
      ),
    );
    const truncated = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]);
    cases.push(create(`${form}/truncated`, truncated, failure(422, 'truncated-mp3')));
  }
  return cases;
}

function mimeUploads(fixture) {
  const cases = [];
  for (const mime of ['audio/mp3', 'application/octet-stream']) {
    cases.push(
      raw(`raw/mime-${mime}`, fixture.bytes, success(fixture.audioFrames), '/file-upload', mime),
    );
    cases.push(
      multipart(
        `multipart/mime-${mime}`,
        fixture.bytes,
        success(fixture.audioFrames),
        '/file-upload',
        { mime },
      ),
    );
  }
  cases.push(
    raw(
      'raw/wrong-mime',
      fixture.bytes,
      failure(415, 'unsupported-media-type'),
      '/file-upload',
      'text/plain',
    ),
  );
  cases.push(
    multipart(
      'multipart/wrong-mime',
      fixture.bytes,
      failure(415, 'unsupported-media-type'),
      '/file-upload',
      { mime: 'text/plain' },
    ),
  );
  return cases;
}

function multipartFaults(fixture) {
  const cases = [
    multipart(
      'multipart/wrong-field',
      fixture.bytes,
      failure(400, 'invalid-upload'),
      '/file-upload',
      { field: 'wrong' },
    ),
  ];
  const bodies = [
    ['missing', `--${boundary}--\r\n`, 400, 'missing-file'],
    [
      'text-field',
      `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nx\r\n` +
        `--${boundary}--\r\n`,
      413,
      'unexpected-fields',
    ],
    ['incomplete', 'unfinished', 400, 'invalid-upload'],
  ];
  for (const [name, body, status, error] of bodies) {
    cases.push(
      raw(
        `multipart/${name}`,
        Buffer.from(body),
        failure(status, error),
        '/file-upload',
        multipartType,
      ),
    );
  }
  const duplicate = async function* () {
    const parts = [];
    for await (const chunk of multipartStream([fixture.bytes])) parts.push(chunk);
    yield* parts.slice(0, -1);
    yield Buffer.from('\r\n');
    yield* parts;
  };
  cases.push({
    id: 'multipart/multiple-files',
    method: 'POST',
    path: '/file-upload',
    body: duplicate,
    headers: { 'content-type': multipartType },
    expected: failure(413, 'too-many-parts'),
  });
  return cases;
}

function limitUploads() {
  const frames = Math.floor(uploadLimit / 417) + 1;
  const common = { method: 'POST', path: '/file-upload', expected: failure(413, 'file-too-large') };
  return [
    {
      id: 'raw/near-limit',
      method: 'POST',
      path: '/file-upload',
      expected: success(frames - 1),
      body: () => frameStream(frames - 1),
      headers: { 'content-type': 'audio/mpeg', 'content-length': String((frames - 1) * 417) },
    },
    {
      id: 'multipart/near-limit',
      method: 'POST',
      path: '/file-upload',
      expected: success(frames - 1),
      body: () => multipartStream(frameStream(frames - 1)),
      headers: { 'content-type': multipartType },
    },
    {
      ...common,
      id: 'raw/declared-limit',
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(frames * 417) },
      // The declared-size gate must reject on headers without waiting for an oversized body.
      body: () => [],
    },
    {
      ...common,
      id: 'raw/chunked-limit',
      headers: { 'content-type': 'audio/mpeg' },
      body: () => frameStream(frames),
    },
    {
      ...common,
      id: 'multipart/file-limit',
      headers: { 'content-type': multipartType },
      body: () => multipartStream(frameStream(frames)),
    },
  ];
}

export function buildScenarios(fixtures) {
  assert.ok(fixtures.length > 0, 'Known fixtures are required');
  return [
    ...fixtureUploads(fixtures),
    ...malformedUploads(fixtures[0]),
    ...mimeUploads(fixtures[0]),
    ...multipartFaults(fixtures[0]),
    ...limitUploads(),
    {
      id: 'method-not-allowed',
      method: 'GET',
      path: '/file-upload',
      expected: { ...failure(405, 'method-not-allowed'), allow: 'POST' },
    },
    { id: 'not-found', method: 'GET', path: '/unknown', expected: failure(404, 'not-found') },
  ];
}
