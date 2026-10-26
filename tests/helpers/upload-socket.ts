import { request, type ClientRequest } from 'node:http';

export interface SocketResponse {
  status: number;
  body: unknown;
  connection: string | undefined;
}

/** A bounded local upload whose sender can deliberately leave the body unfinished. */
export function openUpload(
  address: string,
  contentType: string,
  length?: number,
): { client: ClientRequest; response: Promise<SocketResponse>; closed: Promise<void> } {
  const outcome = Promise.withResolvers<SocketResponse>();
  const client = request(address + '/file-upload', {
    method: 'POST',
    headers: {
      'content-type': contentType,
      ...(length === undefined ? {} : { 'content-length': String(length) }),
    },
  });
  client.on('response', (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.once('error', outcome.reject);
    response.once('end', () => {
      outcome.resolve({
        status: response.statusCode!,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        connection: response.headers.connection,
      });
    });
  });
  client.once('error', outcome.reject);
  client.setTimeout(2_000, () => client.destroy(new Error('Local upload response timed out')));
  const closed = new Promise<void>((resolve) => client.once('close', resolve));
  // Abort tests deliberately stop the client before it has received a response.
  void outcome.promise.catch(() => {});
  return { client, response: outcome.promise, closed };
}
