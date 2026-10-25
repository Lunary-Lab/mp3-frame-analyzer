import { expect, it } from 'vitest';
import { ClientError } from '../src/client-error.js';
import { errorResponseFor, type ErrorResponse } from '../src/error-response.js';
import { Mp3ParseError } from '../src/mp3/errors.js';
import type { UploadForm } from '../src/upload.js';

const failure = (message: string, properties: Record<string, unknown>) =>
  Object.assign(new Error(message), properties);

const response = (
  status: number,
  error: string,
  message: string,
  { closeConnection = false, unexpected = false } = {},
): ErrorResponse => ({ status, body: { error, message }, closeConnection, unexpected });

const internal = response(500, 'internal-error', 'Unable to process upload', { unexpected: true });

it.each<[string, unknown, UploadForm, ErrorResponse]>([
  [
    'a deliberate failure keeps its status, code and message',
    new ClientError(413, 'file-too-large', 'File exceeds configured upload limit'),
    'raw',
    response(413, 'file-too-large', 'File exceeds configured upload limit'),
  ],
  [
    'a deliberate pre-read failure requests connection closure',
    new ClientError(400, 'invalid-option', 'bad option', { closeConnection: true }),
    'multipart',
    response(400, 'invalid-option', 'bad option', { closeConnection: true }),
  ],
  [
    'an unsupported MPEG format is 415',
    new Mp3ParseError('unsupported-format', 0, 'MPEG-2 is not supported'),
    'multipart',
    response(415, 'unsupported-format', 'MPEG-2 is not supported'),
  ],
  [
    'malformed MPEG data is 422',
    new Mp3ParseError('truncated-mp3', 9, 'Truncated final frame'),
    'raw',
    response(422, 'truncated-mp3', 'Truncated final frame'),
  ],
  [
    'a typed framework failure on a raw upload requests connection closure',
    failure('internal detail', { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }),
    'raw',
    response(415, 'unsupported-media-type', 'Expected an MP3 upload', { closeConnection: true }),
  ],
  [
    'a typed framework failure on a multipart upload does not request connection closure',
    failure('internal detail', { code: 'FST_PARTS_LIMIT', statusCode: 413 }),
    'multipart',
    response(413, 'too-many-parts', 'Only one multipart part is allowed'),
  ],
  [
    'a known Busboy protocol message on a multipart upload is 400',
    new Error('Unexpected end of form'),
    'multipart',
    response(400, 'invalid-upload', 'Invalid or incomplete multipart request'),
  ],
  [
    'a multipart stream that closed before the form ended is 400',
    failure('Premature close', { code: 'ERR_STREAM_PREMATURE_CLOSE' }),
    'multipart',
    response(400, 'invalid-upload', 'Invalid or incomplete multipart request'),
  ],
  [
    'a premature close on a raw upload is not a multipart failure',
    failure('Premature close', { code: 'ERR_STREAM_PREMATURE_CLOSE' }),
    'raw',
    internal,
  ],
  [
    'a Busboy message on a raw upload is not a multipart failure',
    new Error('Unexpected end of form'),
    'raw',
    internal,
  ],
  [
    'an unknown framework 413 keeps its status with a sanitized message',
    failure('internal resource detail', { statusCode: 413 }),
    'multipart',
    response(413, 'request-too-large', 'Request exceeds configured limits'),
  ],
  [
    'an unknown framework 415 on a raw upload requests connection closure',
    failure('internal detail', { statusCode: 415 }),
    'raw',
    response(415, 'unsupported-media-type', 'Expected an MP3 upload', { closeConnection: true }),
  ],
  [
    'any other framework 4xx is an invalid request',
    failure('internal detail', { statusCode: 431 }),
    'raw',
    response(431, 'invalid-request', 'Invalid HTTP request', { closeConnection: true }),
  ],
  [
    'an untyped code does not match the framework table',
    failure('internal detail', { code: 42 }),
    'raw',
    internal,
  ],
  ['a framework 5xx is internal', failure('internal detail', { statusCode: 503 }), 'raw', internal],
  ['an arbitrary error is internal', new Error('diagnostic detail'), 'multipart', internal],
  ['a thrown non-error is internal', 'thrown string', 'raw', internal],
])('%s', (_, error, form, expected) => {
  expect(errorResponseFor(error, form)).toEqual(expected);
});
