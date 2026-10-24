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
    async (request) => {
      if (!request.isMultipart()) {
        throw new UploadError(415, 'unsupported-media-type', 'Expected multipart/form-data');
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
          frameCount = await countMp3Frames(part.file.iterator({ destroyOnReturn: false }));
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UploadError) {
      return reply.status(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof Mp3ParseError) {
      const status = error.kind === 'unsupported-format' ? 415 : 422;
      return reply.status(status).send({ error: error.kind, message: error.message });
    }

    // @fastify/multipart raises typed 413/4xx errors for parser limits and malformed forms.
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = status === 413 ? 'file-too-large' : 'invalid-upload';
      const message =
        status === 413 ? 'Multipart upload exceeds configured limits' : 'Invalid multipart upload';
      return reply.status(status).send({ error: code, message });
    }

    // A malformed multipart boundary/body is a client error, not an MP3 error.
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

    request.log.error({ err: error }, 'Unexpected upload failure');
    return reply.status(500).send({ error: 'internal-error', message: 'Unable to process upload' });
  });

  return app;
}
