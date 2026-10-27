import type { IncomingMessage, ServerResponse } from 'node:http';

/** Keep cancellation scoped to the actual consumer, even after an early budget response. */
export async function withUploadCancellation<T>(
  request: IncomingMessage,
  response: ServerResponse,
  consume: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const requestClosed = () => {
    // Normal EOF auto-destroys IncomingMessage too; it is not a client abort.
    if (!request.complete) abort();
  };
  request.on('close', requestClosed);
  // A completed response also makes any still-running consumer work obsolete.
  // Normal successful counting removes these listeners before the response is sent.
  response.on('close', abort);
  response.on('finish', abort);
  if ((request.destroyed && !request.complete) || response.destroyed || response.writableFinished) {
    abort();
  }
  try {
    return await consume(controller.signal);
  } finally {
    request.off('close', requestClosed);
    response.off('close', abort);
    response.off('finish', abort);
  }
}
