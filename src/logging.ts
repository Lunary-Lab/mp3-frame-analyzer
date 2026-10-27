import type { FastifyServerOptions } from 'fastify';

const messages = new Set([
  'incoming request',
  'request completed',
  'request errored',
  'Unexpected upload failure',
  'Upload iterator cleanup failed',
  'Upload connection was closed by the client',
  'Server startup failed',
  'Server shutdown failed',
  'stream closed prematurely',
  'response terminated with an error with headers already sent',
  'The serializer for the given status code failed',
  'request aborted - refusing to accept new requests as server is closing',
]);

function safeMessage(message: unknown): string {
  if (typeof message !== 'string') return 'Application event';
  if (messages.has(message)) return message;
  if (message.startsWith('Server listening at ')) return 'Server listening at configured address';
  return 'Application event';
}

/** Only operational fields cross the application logging boundary, never request or error details. */
export const loggerOptions: Exclude<FastifyServerOptions['logger'], boolean | undefined> = {
  formatters: {
    log: ({ req, res, err, responseTime }) => ({ req, res, err, responseTime }),
  },
  serializers: {
    req: () => ({}),
    res: (reply) => ({ statusCode: reply.statusCode }),
    err: () => ({ type: 'Error', message: 'Details omitted', stack: '' }),
    // Framework fallback paths sometimes use an Error's message as the log message.
    msg: safeMessage,
  },
};
