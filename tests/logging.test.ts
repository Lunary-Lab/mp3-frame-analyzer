import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loggerOptions } from '../src/logging.js';
import { frame, id3v2, mp3, multipartBody } from './helpers/mp3-fixtures.js';

const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL';

interface LogEvent {
  level: number;
  msg: string;
  reqId?: string;
  req?: unknown;
  res?: { statusCode: number };
  err?: unknown;
  responseTime?: number;
}

function captureProductionLogs() {
  vi.stubEnv('NODE_ENV', 'production');
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return {
    text: () => chunks.join(''),
    events: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogEvent),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('keeps production request outcomes without logging caller-controlled request metadata', async () => {
  const logs = captureProductionLogs();
  const app = await buildApp();
  try {
    const audio = frame();
    audio.write(sentinel, 60);
    const payload = mp3([audio], id3v2(Buffer.from(sentinel)));
    const body = multipartBody(payload, { filename: `${sentinel}.mp3` });
    const requests = [
      {
        method: 'POST' as const,
        url: `/file-upload?extra=${sentinel}`,
        payload,
        headers: { 'content-type': 'audio/mpeg' },
        status: 200,
      },
      {
        method: 'POST' as const,
        url: '/file-upload',
        payload: body.payload,
        headers: { 'content-type': body.contentType },
        status: 200,
      },
      {
        method: 'POST' as const,
        url: `/file-upload?includeVbrHeaderFrame=${sentinel}`,
        payload,
        headers: { 'content-type': 'audio/mpeg' },
        status: 400,
      },
      { method: 'GET' as const, url: `/file-upload?token=${sentinel}`, status: 405 },
      { method: 'GET' as const, url: `/${sentinel}`, status: 404 },
    ];
    for (const { status, ...request } of requests) {
      const result = await app.inject({
        ...request,
        headers: {
          ...request.headers,
          host: sentinel,
          authorization: `Bearer ${sentinel}`,
          cookie: `session=${sentinel}`,
          'request-id': sentinel,
          'x-request-id': sentinel,
          'accept-version': sentinel,
        },
      });
      expect(result.statusCode).toBe(status);
      expect(result.body).not.toContain(sentinel);
    }
    expect(logs.text()).not.toContain(sentinel);
    const events = logs.events();
    const incoming = events.filter(({ msg }) => msg === 'incoming request');
    const completed = events.filter(({ msg }) => msg === 'request completed');
    expect(incoming).toHaveLength(requests.length);
    for (const event of incoming) expect(event.req).toEqual({});
    for (const event of completed) expect(Object.keys(event.res ?? {})).toEqual(['statusCode']);
    expect(completed.map(({ res }) => res?.statusCode)).toEqual(
      requests.map(({ status }) => status),
    );
    expect(new Set(incoming.map(({ reqId }) => reqId)).size).toBe(requests.length);
    for (const [index, event] of completed.entries()) {
      expect(event.reqId).toMatch(/^req-[0-9a-z]+$/);
      expect(event.reqId).toBe(incoming[index]?.reqId);
      expect(event.responseTime).toBeGreaterThanOrEqual(0);
    }
  } finally {
    await app.close();
  }
});

it('suppresses arbitrary error fields while preserving safe error events and generic HTTP errors', async () => {
  const logs = captureProductionLogs();
  const app = await buildApp();
  const failure = Object.assign(new Error(sentinel, { cause: new Error(sentinel) }), {
    name: sentinel,
    code: sentinel,
    stack: sentinel,
    body: sentinel,
    headers: { authorization: sentinel },
  });
  app.get('/synthetic-failure', () => {
    throw failure;
  });
  try {
    const response = await app.inject('/synthetic-failure');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'internal-error',
      message: 'Unable to process upload',
    });
    expect(logs.text()).not.toContain(sentinel);
    const errors = logs.events().filter(({ level }) => level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'Unexpected upload failure',
      reqId: 'req-1',
      err: { type: 'Error', message: 'Details omitted', stack: '' },
    });
  } finally {
    await app.close();
  }
});

it('suppresses fallback messages and unrelated structured fields in instance-level logs', async () => {
  const logs = captureProductionLogs();
  const app = await buildApp();
  try {
    const failure = new Error(sentinel);
    app.log.error({ err: failure, payload: sentinel, headers: { host: sentinel } }, sentinel);
    app.log.error(failure);
    app.log.info(`Server listening at ${sentinel}`);
    app.log.error({ err: failure }, 'Server startup failed');
    app.log.error({ err: failure }, 'Server shutdown failed');
    expect(logs.text()).not.toContain(sentinel);
    const events = logs.events();
    expect(events.map(({ msg }) => msg)).toEqual([
      'Application event',
      'Application event',
      'Server listening at configured address',
      'Server startup failed',
      'Server shutdown failed',
    ]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        ['level', 'time', 'pid', 'hostname', 'msg', ...(event.err ? ['err'] : [])].sort(),
      );
    }
  } finally {
    await app.close();
  }
});

it('does not stringify untrusted non-string log messages', () => {
  const message = loggerOptions.serializers?.['msg'];
  expect(message).toBeTypeOf('function');
  expect(message?.({ toString: () => sentinel })).toBe('Application event');
});
