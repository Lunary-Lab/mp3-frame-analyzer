import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { expect, it } from 'vitest';
import { withUploadCancellation } from '../src/upload-cancellation.js';

function transport() {
  const request = new IncomingMessage(new Socket());
  const response = new ServerResponse(request);
  return { request, response };
}
function listeners(request: IncomingMessage, response: ServerResponse) {
  return [
    request.listenerCount('close'),
    response.listenerCount('close'),
    response.listenerCount('finish'),
  ];
}

it.each(['request-close', 'response-close', 'response-finish'])(
  'cancels a live consumer on %s and removes only its own listeners',
  async (event) => {
    const { request, response } = transport();
    const other = () => {};
    request.on('close', other);
    response.on('close', other);
    response.on('finish', other);
    const before = listeners(request, response);
    const release = Promise.withResolvers<void>();
    const seen = Promise.withResolvers<AbortSignal>();
    const result = withUploadCancellation(request, response, (signal) => {
      seen.resolve(signal);
      return release.promise;
    });
    const signal = await seen.promise;
    expect(signal.aborted).toBe(false);
    if (event === 'request-close') request.emit('close');
    else response.emit(event === 'response-close' ? 'close' : 'finish');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: 'AbortError' });
    release.resolve();
    await result;
    expect(listeners(request, response)).toEqual(before);
  },
);

it('does not abort normal request EOF and preserves a successful result', async () => {
  const { request, response } = transport();
  request.complete = true;
  request.destroy();
  const before = listeners(request, response);
  const result = await withUploadCancellation(request, response, async (signal) => {
    request.emit('close');
    expect(signal.aborted).toBe(false);
    return 42;
  });
  expect(result).toBe(42);
  expect(listeners(request, response)).toEqual(before);
});

it.each(['request', 'response', 'finished'])(
  'starts cancelled when %s has already terminated and preserves the thrown reason',
  async (kind) => {
    const { request, response } = transport();
    if (kind === 'request') request.destroy();
    if (kind === 'response') response.destroy();
    if (kind === 'finished') Object.defineProperty(response, 'writableFinished', { value: true });
    const before = listeners(request, response);
    await expect(
      withUploadCancellation(request, response, async (signal) => {
        signal.throwIfAborted();
        return 42;
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(listeners(request, response)).toEqual(before);
  },
);

it('preserves an ordinary consumer failure and removes all cancellation listeners', async () => {
  const { request, response } = transport();
  const before = listeners(request, response);
  const failure = new Error('consumer failed');
  await expect(
    withUploadCancellation(request, response, () => Promise.reject(failure)),
  ).rejects.toBe(failure);
  expect(listeners(request, response)).toEqual(before);
});
