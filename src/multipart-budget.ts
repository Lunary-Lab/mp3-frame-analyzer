import type { FastifyReply, FastifyRequest } from 'fastify';
import { ClientError } from './client-error.js';

const requestTooLarge = () =>
  new ClientError(413, 'request-too-large', 'Multipart body exceeds configured upload limit', {
    closeConnection: true,
  });

/** Stop reading now; let an already chosen response finish before closing its connection. */
export function stopAfterResponse(request: FastifyRequest, reply: FastifyReply): void {
  request.raw.pause();
  if (!reply.raw.headersSent) reply.header('connection', 'close');
  if (reply.raw.writableFinished || reply.raw.destroyed) {
    request.raw.destroy();
    return;
  }
  const close = () => {
    reply.raw.off('finish', close);
    reply.raw.off('close', close);
    request.raw.destroy();
  };
  reply.raw.once('finish', close);
  reply.raw.once('close', close);
}

/**
 * Bound all transfer-decoded multipart body bytes, including discarded data.
 * @fastify/multipart reads raw directly, bypassing preParsing payload transforms.
 * Pause before attaching the observer: only the parser's pipe may start flow or
 * resume normal reads after backpressure. Overflow holds the stream paused
 * until response closure without detaching its EOF path. EventEmitter may
 * still deliver the crossing chunk to the parser; the violation promise prevents accepting that operation.
 */
export async function withMultipartBudget<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  limit: number,
  consume: () => Promise<T>,
): Promise<T> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) throw requestTooLarge();
  let remaining = limit;
  let failure: ClientError | undefined;
  const exceeded = Promise.withResolvers<never>();
  const onData = (chunk: Buffer) => {
    if (failure !== undefined) return;
    if (chunk.length <= remaining) {
      remaining -= chunk.length;
      return;
    }
    failure = requestTooLarge();
    stopAfterResponse(request, reply);
    exceeded.reject(failure);
  };
  // Keep the pipe's end handler: a fully buffered body can end normally after
  // overflow, and the plugin deliberately ignores normal raw close events.
  // A pending downstream drain may try to resume; stop it before flow restarts.
  const onResume = () => {
    if (failure !== undefined) request.raw.pause();
  };
  const cleanup = () => {
    request.raw.off('data', onData);
    request.raw.off('resume', onResume);
    request.raw.off('end', cleanup);
    request.raw.off('close', cleanup);
  };
  request.raw.pause();
  request.raw.on('data', onData);
  request.raw.on('resume', onResume);
  request.raw.once('end', cleanup);
  request.raw.once('close', cleanup);
  // Calling consume starts iteration, not just construction of request.parts().
  // Keep the observer after early rejection until the background drain ends.
  const result = await Promise.race([consume(), exceeded.promise]);
  if (failure !== undefined) throw failure;
  return result;
}
