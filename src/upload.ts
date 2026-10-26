import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart, { type MultipartFile } from '@fastify/multipart';
import { ClientError } from './client-error.js';
import { createUploadWork, type UploadWork } from './upload-work.js';
import { stopAfterResponse, withMultipartBudget } from './multipart-budget.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Project-policy allowance for multipart framing, not another file allowance. */
export function defaultMaxMultipartBytes(maxUploadBytes: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, maxUploadBytes + 64 * 1024);
}

/** Accepted for a raw upload's request and a multipart upload's form part alike. */
const mp3MediaTypes = new Set(['audio/mpeg', 'audio/mp3', 'application/octet-stream']);

/**
 * Whether a media type, without parameters, is accepted. Media types are
 * case-insensitive (RFC 9110 §8.3.1), and only SP or HTAB counts as the
 * optional whitespace around one (RFC 9110 §5.6.3).
 */
function isAcceptedMediaType(mediaType: string): boolean {
  return mp3MediaTypes.has(mediaType.replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase());
}

/** The two ways a client can send an upload. */
export type UploadForm = 'raw' | 'multipart';

/** Any request that is not a multipart form is an attempted raw upload. */
export function uploadFormOf(request: FastifyRequest): UploadForm {
  return request.isMultipart() ? 'multipart' : 'raw';
}

const fileTooLarge = () =>
  new ClientError(413, 'file-too-large', 'File exceeds configured upload limit');
const emptyUpload = () => new ClientError(400, 'empty-file', 'The MP3 file must not be empty');

/** Reads an upload's bytes, such as the MP3 frame counter. */
export type UploadConsumer<T> = (upload: AsyncIterable<Uint8Array>) => Promise<T>;

export interface Uploads {
  /**
   * Feed one raw or multipart upload to `consumer` and return its result.
   *
   * Upload faults this module detects reject with a ClientError: before
   * `consumer` runs where possible, otherwise by failing its iteration of the
   * upload, which the consumer must let propagate. Multipart protocol and limit
   * errors from the multipart plugin propagate as raised. An observed file
   * truncation is file-too-large even if the consumer swallowed its failure;
   * later multipart faults do not replace an earlier response.
   * A started iterator is closed on return or rejection. Raw early returns and
   * failures close the connection without draining. Multipart early success
   * awaits the remainder; consumer rejection starts a background drain. Both remain
   * subject to the aggregate body budget and transport timeouts. Reuse requires
   * the body to finish within those bounds. Consumers must await their reads;
   * this cannot cancel arbitrary detached work inside a custom consumer.
   */
  consume<T>(request: FastifyRequest, reply: FastifyReply, consumer: UploadConsumer<T>): Promise<T>;
  /**
   * After consume settles, observe remaining multipart parsing/draining work.
   * This does not wait for a raw consumer or replace the primary HTTP result.
   */
  waitForIdle(request: FastifyRequest): Promise<void>;
}

/** Register both upload forms with a shared file cap and a multipart body cap. */
export async function registerUploads(
  app: FastifyInstance,
  {
    maxUploadBytes,
    maxMultipartBytes = defaultMaxMultipartBytes(maxUploadBytes),
  }: { maxUploadBytes: number; maxMultipartBytes?: number },
): Promise<Uploads> {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
    throw new RangeError('maxUploadBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxMultipartBytes) || maxMultipartBytes < 1) {
    throw new RangeError('maxMultipartBytes must be a positive safe integer');
  }
  // Fastify delegates the raw request body without buffering it in memory.
  // Its normal parseAs:'buffer' size protection does not apply to this path.
  app.addContentTypeParser([...mp3MediaTypes], (_request, payload, done) => done(null, payload));
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
    // RFC 7578 permits file parts without filenames. Busboy otherwise treats
    // audio media types without a filename as text fields.
    isPartAFile: (_fieldName, contentType, fileName) =>
      fileName !== undefined || isAcceptedMediaType(contentType ?? ''),
  });
  const work = createUploadWork();
  return {
    waitForIdle: (request) => work.waitForIdle(request),
    consume: (request, reply, consumer) =>
      uploadFormOf(request) === 'multipart'
        ? withMultipartBudget(request, reply, maxMultipartBytes, () =>
            work.track(request, consumeMultipartUpload(request, reply, consumer, work)),
          )
        : consumeRawUpload(request, reply, maxUploadBytes, consumer),
  };
}

async function consumeRawUpload<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  maxUploadBytes: number,
  consumer: UploadConsumer<T>,
): Promise<T> {
  if (!isAcceptedMediaType(mediaTypeOf(request))) {
    // A body Fastify already handed over is unread: never drain it.
    if (isBodyStream(request.body)) reply.header('connection', 'close');
    throw new ClientError(415, 'unsupported-media-type', 'Expected an MP3 upload');
  }
  try {
    const body = request.body;
    if (!isBodyStream(body)) throw emptyUpload();
    const declaredSize = request.headers['content-length'];
    if (declaredSize !== undefined && Number(declaredSize) > maxUploadBytes) throw fileTooLarge();
    // The multipart limit does not apply to raw request streams; enforce it per chunk.
    const { result, exhausted } = await consumeStream(request, body, maxUploadBytes, consumer);
    if (!exhausted) reply.header('connection', 'close');
    return result;
  } catch (error) {
    // Never drain the unread remainder of a raw upload: an attacker controls
    // its length. Ending this connection after the JSON response is safe for
    // HTTP/1.1 and avoids reading that stream in the background.
    reply.header('connection', 'close');
    throw error;
  }
}

async function consumeMultipartUpload<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  consumer: UploadConsumer<T>,
  work: UploadWork,
): Promise<T> {
  let consumed: { readonly result: T } | undefined;
  for await (const part of multipartParts(request, reply)) {
    if (part.type !== 'file') {
      throw new ClientError(400, 'invalid-upload', 'Only one file field is accepted');
    }
    if (part.fieldname !== 'file') {
      // Busboy expects a yielded form part to be consumed. Drain rejected
      // parts without buffering rather than abandoning a live stream.
      await discardPart(part.file);
      throw new ClientError(400, 'invalid-upload', 'Upload field must be named "file"');
    }
    if (!isAcceptedMediaType(part.mimetype)) {
      await discardPart(part.file);
      throw new ClientError(415, 'unsupported-media-type', 'Expected an MP3 file');
    }
    consumed = { result: await consumeMultipartStream(request, part.file, consumer, work) };
  }
  if (consumed === undefined) {
    throw new ClientError(400, 'missing-file', 'A multipart field named "file" is required');
  }
  return consumed.result;
}

/** Provider failures may unpipe before raw EOF; never leave that unread body reusable. */
async function* multipartParts(request: FastifyRequest, reply: FastifyReply) {
  try {
    yield* request.parts();
  } catch (error) {
    // Consumer errors occur outside this iterator and retain their bounded
    // background drain. A failed provider no longer guarantees that drain.
    if (!request.raw.readableEnded) stopAfterResponse(request, reply);
    throw error;
  }
}

async function consumeMultipartStream<T>(
  request: FastifyRequest,
  stream: MultipartFile['file'],
  consumer: UploadConsumer<T>,
  work: UploadWork,
): Promise<T> {
  try {
    // Destroying an unfinished Busboy stream stalls the request body, so a
    // consumer that stops early must leave it drainable. The multipart plugin
    // enforces the size limit itself.
    const { result } = await consumeStream(request, stream, Infinity, consumer);
    // A successful early return is not permission to abandon the form: finish
    // its remainder under the aggregate budget before accepting the result.
    await discardPart(stream);
    if (stream.bytesRead === 0) throw emptyUpload();
    if (!stream.truncated) return result;
  } catch (error) {
    // A stream truncated at the multipart limit is a transport error, not
    // whatever the consumer made of the bytes it received.
    drainUnreadRemainder(request, stream, work);
    if (!stream.truncated) throw error;
  }
  throw fileTooLarge();
}

/** Fastify hands an accepted raw body over as a stream; bodiless requests have none. */
function isBodyStream(body: unknown): body is Readable {
  return typeof (body as Readable | undefined)?.iterator === 'function';
}

/** The request's media type with its parameters removed; Busboy does this for form parts. */
function mediaTypeOf(request: FastifyRequest): string {
  return String(request.headers['content-type'] ?? '').split(';')[0]!;
}

/** Discard a rejected form part so multipart parsing can finish normally. */
async function discardPart(stream: Readable): Promise<void> {
  const completion = finished(stream, { cleanup: true });
  stream.resume();
  await completion;
}

/**
 * The consumer can reject an upload long before it ends. Keep reading the
 * rest in the background without delaying the response. The request-level
 * aggregate budget remains active; reuse requires completion within that cap
 * and the transport timeouts.
 */
function drainUnreadRemainder(request: FastifyRequest, stream: Readable, work: UploadWork): void {
  // A malformed or interrupted remainder cannot change the response already sent.
  void work.track(request, discardPart(stream)).catch(() => {});
}

/**
 * Pass an upload's chunks through, rejecting non-byte chunks, more than
 * `limit` bytes, and an upload with no bytes at all, which is missing rather
 * than malformed.
 */
async function* checkedUpload(
  stream: Readable,
  limit: number,
  state: { exhausted: boolean },
): AsyncGenerator<Uint8Array> {
  let received = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    if (!(chunk instanceof Uint8Array)) {
      throw new ClientError(400, 'invalid-upload', 'Invalid raw byte chunk');
    }
    received += chunk.length;
    if (received > limit) throw fileTooLarge();
    yield chunk;
  }
  if (received === 0) throw emptyUpload();
  state.exhausted = true;
}

/** Close a started consumer iterator even when its caller forgets to do so. */
async function consumeStream<T>(
  request: FastifyRequest,
  stream: Readable,
  limit: number,
  consumer: UploadConsumer<T>,
): Promise<{ result: T; exhausted: boolean }> {
  const state = { exhausted: false };
  const upload = checkedUpload(stream, limit, state);
  let result: T;
  try {
    result = await consumer(upload);
  } catch (error) {
    try {
      await upload.return(undefined);
    } catch (cleanupError) {
      // Preserve the primary failure, but do not hide an unexpected cleanup bug.
      request.log.error({ err: cleanupError }, 'Upload iterator cleanup failed');
    }
    throw error;
  }
  await upload.return(undefined);
  return { result, exhausted: state.exhausted };
}
