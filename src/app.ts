import Fastify, { type FastifyInstance } from 'fastify';
import { countMp3Frames } from './mp3/count-frames.js';
import { ClientError } from './client-error.js';
import { errorResponseFor } from './error-response.js';
import { MAX_UPLOAD_BYTES, registerUploads, uploadFormOf } from './upload.js';

function includeVbrHeaderFrame(query: unknown): boolean {
  const value =
    typeof query === 'object' && query !== null && 'includeVbrHeaderFrame' in query
      ? query.includeVbrHeaderFrame
      : undefined;
  // The HTTP contract excludes one recognized initial encoder-metadata frame.
  // Pass an explicit policy so the low-level parser's physical default is unchanged.
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  // Rejected before the upload is read, so a persistent connection is unsafe.
  throw new ClientError(400, 'invalid-option', 'includeVbrHeaderFrame must be "true" or "false"', {
    closeConnection: true,
  });
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

/** One per-file upload limit for deployment configuration and focused boundary tests. */
export async function buildApp({
  maxUploadBytes = MAX_UPLOAD_BYTES,
}: { maxUploadBytes?: number } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env['NODE_ENV'] !== 'test',
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  });
  const uploads = await registerUploads(app, { maxUploadBytes });

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
      const include = includeVbrHeaderFrame(request.query);
      const frameCount = await uploads.consume(request, reply, (upload) =>
        countMp3Frames(upload, { includeVbrHeaderFrame: include }),
      );
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
    const response = errorResponseFor(error, uploadFormOf(request));
    if (response.unexpected) request.log.error({ err: error }, 'Unexpected upload failure');
    if (response.closeConnection) reply.header('connection', 'close');
    return reply.status(response.status).send(response.body);
  });

  return app;
}
