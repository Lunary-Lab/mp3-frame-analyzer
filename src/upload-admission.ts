import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Uploads } from './upload.js';

export const DEFAULT_MAX_ACTIVE_UPLOADS = 8;
export const MAX_ACTIVE_UPLOADS_LIMIT = 1024;

/** Closing an unread request only after its sanitized response avoids resets hiding the 503. */
function rejectBusy(request: FastifyRequest, reply: FastifyReply): void {
  request.raw.pause();
  const close = () => {
    reply.raw.off('finish', close);
    reply.raw.off('close', close);
    request.raw.destroy();
  };
  reply.raw.once('finish', close);
  reply.raw.once('close', close);
  void reply.header('connection', 'close').header('retry-after', '1').status(503).send({
    error: 'server-busy',
    message: 'Upload capacity is temporarily exhausted',
  });
}

function lifetime(request: FastifyRequest, reply: FastifyReply, release: () => void) {
  let transportDone = request.raw.readableEnded || request.raw.destroyed;
  let responseDone = false;
  let operationDone = true;
  let started = false;
  let released = false;
  const complete = () => {
    if (released || !transportDone || !responseDone || !operationDone) return;
    released = true;
    request.raw.off('end', endTransport);
    request.raw.off('close', endTransport);
    reply.raw.off('finish', endResponse);
    reply.raw.off('close', endResponse);
    release();
  };
  const endTransport = () => {
    transportDone = true;
    complete();
  };
  const endResponse = () => {
    responseDone = true;
    if (reply.getHeader('connection') === 'close') request.raw.destroy();
    complete();
  };
  request.raw.once('end', endTransport);
  request.raw.once('close', endTransport);
  reply.raw.once('finish', endResponse);
  reply.raw.once('close', endResponse);
  return {
    hasStarted: () => started,
    start: () => {
      started = true;
      operationDone = false;
    },
    settle: () => {
      operationDone = true;
      complete();
    },
  };
}

/** A per-app admission cap, not a queue or a fleet-wide quota. */
export function createUploadAdmission(app: FastifyInstance, uploads: Uploads, maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ACTIVE_UPLOADS_LIMIT) {
    throw new RangeError('maxActiveUploads must be an integer between 1 and 1024');
  }
  const transports = new Set<FastifyRequest['raw']>();
  let closing = false;
  let onIdle: (() => void) | undefined;
  const permits = new WeakMap<FastifyRequest, ReturnType<typeof lifetime>>();
  app.addHook('onSend', (request, reply, payload, done) => {
    // A hook/protocol failure can respond before any body reader exists. Do not
    // keep its unread IncomingMessage (or admission slot) alive after the response.
    const permit = permits.get(request);
    if (
      permit !== undefined &&
      !request.raw.readableEnded &&
      (!permit.hasStarted() || !request.raw.readableDidRead)
    ) {
      reply.header('connection', 'close');
    }
    done(null, payload);
  });
  app.addHook('preClose', (done) => {
    closing = true;
    done();
  });
  app.addHook('onClose', async () => {
    // Transport is already closed; discard any buffered IncomingMessage remainder.
    for (const raw of transports) raw.destroy();
    if (transports.size > 0)
      await new Promise<void>((resolve) => {
        onIdle = resolve;
      });
  });
  const onRequest: onRequestHookHandler = (request, reply, done) => {
    if (closing || transports.size >= maximum) {
      rejectBusy(request, reply);
      return;
    }
    transports.add(request.raw);
    const permit = lifetime(request, reply, () => {
      transports.delete(request.raw);
      permits.delete(request);
      if (transports.size === 0) onIdle?.();
    });
    permits.set(request, permit);
    done();
  };
  return {
    onRequest,
    async run<T>(request: FastifyRequest, operation: () => Promise<T>): Promise<T> {
      const permit = permits.get(request)!;
      permit.start();
      try {
        return await operation();
      } finally {
        // Response latency and slot ownership differ: draining can outlive a rejection.
        void uploads.waitForIdle(request).then(() => permit.settle());
      }
    },
  };
}
