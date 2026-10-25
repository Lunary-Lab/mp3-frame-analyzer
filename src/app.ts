import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { countMp3Frames } from './mp3/count-frames.js';
import { Mp3ParseError } from './mp3/errors.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Busboy currently reports these protocol failures without a typed statusCode.
// Keep this list specific so unrelated application errors still become HTTP 500.
const multipartParseErrors = new Set([
  'Multipart: Boundary not found',
  'Unexpected end of multipart data',
  'Unexpected end of form',
  'Part terminated early due to unexpected end of multipart data',
  'Preamble terminated early due to unexpected end of multipart data',
]);

class UploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.code = code;
  }
}

/** Discard an unwanted file part so multipart parsing can finish normally. */
async function discardFile(file: Readable): Promise<void> {
  const completion = finished(file, { cleanup: true });
  file.resume();
  await completion;
}

/**
 * The parser can reject a file long before its upload ends. Keep reading the
 * rest in the background so the error responds immediately, Busboy completes,
 * and the connection can serve its next request or close during shutdown.
 */
function drainRejectedFile(file: Readable): void {
  // A malformed or interrupted remainder cannot change the response already sent.
  discardFile(file).catch(() => {});
}

const rawMp3Types = new Set(['audio/mpeg', 'audio/mp3', 'application/octet-stream']);

/**
 * Match the actual typed Fastify 5 / @fastify/multipart 10.1.6 errors, not just
 * their numeric HTTP status. All four multipart limits use 413, but only one
 * actually means that the uploaded file's bytes exceeded the size limit.
 */
const frameworkClientErrors = new Map<string, readonly [number, string, string]>([
  ['FST_REQ_FILE_TOO_LARGE', [413, 'file-too-large', 'MP3 file exceeds the upload limit']],
  ['FST_FILES_LIMIT', [413, 'too-many-files', 'Only one file part is allowed']],
  ['FST_FIELDS_LIMIT', [413, 'unexpected-fields', 'Multipart text fields are not allowed']],
  ['FST_PARTS_LIMIT', [413, 'too-many-parts', 'Only one multipart part is allowed']],
  ['FST_MP_PREMATURE_CLOSE', [400, 'invalid-upload', 'Multipart request ended early']],
  ['FST_PROTO_VIOLATION', [400, 'invalid-upload', 'Invalid multipart field name']],
  ['FST_INVALID_JSON_FIELD_ERROR', [400, 'invalid-upload', 'Invalid multipart field']],
  ['FST_INVALID_MULTIPART_CONTENT_TYPE', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_INVALID_MEDIA_TYPE', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_EMPTY_JSON_BODY', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_INVALID_JSON_BODY', [415, 'unsupported-media-type', 'Expected an MP3 upload']],
  ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', [400, 'invalid-request', 'Invalid Content-Length']],
  ['FST_ERR_CTP_BODY_TOO_LARGE', [413, 'request-too-large', 'Request body exceeds the limit']],
]);

/** A zero-byte file is a missing payload, not a malformed MPEG bitstream. */
async function* nonEmptyFile(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let received = 0;
  for await (const chunk of input) {
    received += chunk.length;
    yield chunk;
  }
  if (received === 0) {
    throw new UploadError(400, 'empty-file', 'The MP3 file must not be empty');
  }
}

/** The multipart limit does not apply to raw request streams. Enforce it per chunk. */
async function* boundedRawUpload(file: Readable, limit: number): AsyncGenerator<Uint8Array> {
  let received = 0;
  for await (const chunk of file.iterator({ destroyOnReturn: false })) {
    if (!(chunk instanceof Uint8Array)) {
      throw new UploadError(400, 'invalid-upload', 'Invalid raw byte chunk');
    }
    received += chunk.length;
    if (received > limit) {
      throw new UploadError(413, 'file-too-large', 'File exceeds configured upload limit');
    }
    yield chunk;
  }
  if (received === 0) {
    throw new UploadError(400, 'empty-file', 'The MP3 file must not be empty');
  }
}

function includeVbrHeaderFrame(query: unknown): boolean {
  const value =
    typeof query === 'object' && query !== null && 'includeVbrHeaderFrame' in query
      ? query.includeVbrHeaderFrame
      : undefined;
  // The HTTP contract excludes one recognized initial encoder-metadata frame.
  // Pass an explicit policy so the low-level parser's physical default is unchanged.
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new UploadError(400, 'invalid-option', 'includeVbrHeaderFrame must be "true" or "false"');
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'message'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

/** A smaller limit can be supplied by tests without changing the production default. */
export async function buildApp({
  maxUploadBytes = MAX_UPLOAD_BYTES,
}: { maxUploadBytes?: number } = {}): Promise<FastifyInstance> {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
    throw new RangeError('maxUploadBytes must be a positive safe integer');
  }
  const app = Fastify({
    logger: process.env['NODE_ENV'] !== 'test',
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  });

  const multipartLimits = {
    files: 1,
    fields: 0,
    parts: 1,
    fileSize: maxUploadBytes,
    // The plugin forwards headerSize to Busboy although its limits type omits
    // that option. Busboy bounds header buffering; exact field validation is below.
    headerSize: 8 * 1024,
    headerPairs: 32,
  };
  // Fastify delegates the raw request body without buffering it in memory.
  // Its normal parseAs:'buffer' size protection does not apply to this path.
  app.addContentTypeParser([...rawMp3Types], (_request, payload, done) => done(null, payload));

  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: multipartLimits,
  });

  app.post(
    '/file-upload',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['frameCount'],
            properties: { frameCount: { type: 'integer', minimum: 0 } },
          },
          400: errorSchema,
          413: errorSchema,
          415: errorSchema,
          422: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (request, reply) => {
      let include: boolean;
      try {
        include = includeVbrHeaderFrame(request.query);
      } catch (error) {
        // The body has not been consumed; a persistent connection is unsafe.
        reply.header('connection', 'close');
        throw error;
      }
      if (!request.isMultipart()) {
        const mime = String(request.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        if (!rawMp3Types.has(mime)) {
          throw new UploadError(415, 'unsupported-media-type', 'Expected an MP3 upload');
        }
        const file = request.body as Readable | undefined;
        if (!file || typeof file.iterator !== 'function') {
          reply.header('connection', 'close');
          throw new UploadError(400, 'empty-file', 'The MP3 file must not be empty');
        }
        const declaredSize = request.headers['content-length'];
        if (declaredSize !== undefined && Number(declaredSize) > maxUploadBytes) {
          reply.header('connection', 'close');
          throw new UploadError(413, 'file-too-large', 'File exceeds configured upload limit');
        }
        try {
          return {
            frameCount: await countMp3Frames(boundedRawUpload(file, maxUploadBytes), {
              includeVbrHeaderFrame: include,
            }),
          };
        } catch (error) {
          // Do not drain arbitrary amounts of an already-rejected raw request.
          // Ending this connection after the JSON response is safe for HTTP/1.1,
          // and avoids reading an attacker-controlled stream in the background.
          reply.header('connection', 'close');
          throw error;
        }
      }

      let frameCount: number | undefined;
      for await (const part of request.parts()) {
        if (part.type !== 'file') {
          throw new UploadError(400, 'invalid-upload', 'Only one file field is accepted');
        }
        if (part.fieldname !== 'file') {
          // Busboy expects a yielded file part to be consumed. Drain rejected
          // uploads without buffering rather than abandoning a live stream.
          await discardFile(part.file);
          throw new UploadError(400, 'invalid-upload', 'Upload field must be named "file"');
        }
        if (!['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(part.mimetype)) {
          await discardFile(part.file);
          throw new UploadError(415, 'unsupported-media-type', 'Expected an MP3 file');
        }

        try {
          // Destroying an unfinished Busboy file stream stalls the request
          // body, so an early parser rejection must leave it drainable.
          frameCount = await countMp3Frames(
            nonEmptyFile(part.file.iterator({ destroyOnReturn: false })),
            { includeVbrHeaderFrame: include },
          );
        } catch (error) {
          // A file truncated at the multipart limit is a transport error,
          // not a malformed-MP3 parser error.
          if (part.file.truncated) {
            throw new UploadError(413, 'file-too-large', 'File exceeds configured upload limit');
          }
          if (error instanceof Mp3ParseError) drainRejectedFile(part.file);
          throw error;
        }
        if (part.file.truncated) {
          throw new UploadError(413, 'file-too-large', 'File exceeds configured upload limit');
        }
      }

      if (frameCount === undefined) {
        throw new UploadError(400, 'missing-file', 'A multipart field named "file" is required');
      }
      return { frameCount };
    },
  );

  // Fastify's default 404 is not a method error; explicitly distinguish known
  // /file-upload routes from unknown paths without intercepting other routes.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.split('?', 1)[0] === '/file-upload') {
      return reply.header('allow', 'POST').status(405).send({
        error: 'method-not-allowed',
        message: 'Use POST /file-upload',
      });
    }
    return reply.status(404).send({ error: 'not-found', message: 'Route not found' });
  });

  app.setErrorHandler((error, request, reply) => {
    // No HTTP response is possible after the peer disconnects mid-request.
    if (request.raw.aborted || reply.raw.destroyed) {
      request.log.debug({ err: error }, 'Upload connection was closed by the client');
      reply.raw.destroy();
      return reply;
    }
    if (error instanceof UploadError) {
      return reply.status(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof Mp3ParseError) {
      const status = error.kind === 'unsupported-format' ? 415 : 422;
      return reply.status(status).send({ error: error.kind, message: error.message });
    }

    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    const mapped = code === undefined ? undefined : frameworkClientErrors.get(code);
    if (mapped !== undefined) {
      if (!request.isMultipart()) reply.header('connection', 'close');
      const [status, errorCode, message] = mapped;
      return reply.status(status).send({ error: errorCode, message });
    }

    // Busboy can report protocol errors without a stable typed error code.
    if (
      request.isMultipart() &&
      error instanceof Error &&
      multipartParseErrors.has(error.message)
    ) {
      return reply.status(400).send({
        error: 'invalid-upload',
        message: 'Invalid or incomplete multipart request',
      });
    }

    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Unknown framework errors retain their HTTP category but never expose
      // potentially unsafe original messages or masquerade as multipart errors.
      if (!request.isMultipart()) reply.header('connection', 'close');
      if (status === 413) {
        return reply.status(status).send({
          error: 'request-too-large',
          message: 'Request exceeds configured limits',
        });
      }
      if (status === 415) {
        return reply.status(status).send({
          error: 'unsupported-media-type',
          message: 'Expected an MP3 upload',
        });
      }
      return reply.status(status).send({
        error: 'invalid-request',
        message: 'Invalid HTTP request',
      });
    }

    request.log.error({ err: error }, 'Unexpected upload failure');
    return reply.status(500).send({ error: 'internal-error', message: 'Unable to process upload' });
  });

  return app;
}
