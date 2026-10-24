import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { countMp3Frames } from './mp3/count-frames.js';
import { Mp3ParseError } from './mp3/errors.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

class UploadError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Discard an unwanted file part so multipart parsing can finish normally. */
async function discardFile(file: Readable): Promise<void> {
  const completion = finished(file);
  file.resume();
  await completion;
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
export async function buildApp(
  { maxUploadBytes = MAX_UPLOAD_BYTES }: { maxUploadBytes?: number } = {},
): Promise<FastifyInstance> {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
    throw new RangeError('maxUploadBytes must be a positive safe integer');
  }
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  });

  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      files: 1,
      fields: 0,
      parts: 1,
      fileSize: maxUploadBytes,
      fieldNameSize: 64,
      headerPairs: 32,
    },
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
          frameCount = await countMp3Frames(part.file);
        } catch (error) {
          // A file truncated at the multipart limit is a transport error,
          // not a malformed-MP3 parser error.
          if (part.file.truncated) {
            throw new UploadError(413, 'file-too-large', 'File exceeds configured upload limit');
          }
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
    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const code = status === 413 ? 'file-too-large' : 'invalid-upload';
      const message =
        status === 413 ? 'Multipart upload exceeds configured limits' : 'Invalid multipart upload';
      return reply.status(status).send({ error: code, message });
    }

    request.log.error({ err: error }, 'Unexpected upload failure');
    return reply.status(500).send({ error: 'internal-error', message: 'Unable to process upload' });
  });

  return app;
}
