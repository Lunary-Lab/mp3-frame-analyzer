import { connect } from 'node:net';

/** POST uploads over one TCP connection; each response needs the prior body consumed. */
export async function sendPipelined(
  baseUrl: string,
  uploads: readonly { payload: Buffer; contentType: string }[],
): Promise<{ status: number; body: unknown }[]> {
  const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1');
  try {
    let received = '';
    const responses = /HTTP\/1\.1 (\d{3})[^]*?\r\n\r\n(\{[^}]*\})/g;
    const complete = new Promise<void>((resolve, reject) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
        if (received.match(responses)?.length === uploads.length) resolve();
      });
      socket.once('error', reject);
      socket.once('close', () => reject(new Error(`Connection closed after: ${received}`)));
    });
    for (const { payload, contentType } of uploads) {
      socket.write(
        `POST /file-upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${contentType}\r\nContent-Length: ${payload.length}\r\n\r\n`,
      );
      socket.write(payload);
    }
    await complete;
    return [...received.matchAll(responses)].map(([, status, body]) => ({
      status: Number(status),
      body: JSON.parse(body!) as unknown,
    }));
  } finally {
    socket.destroy();
  }
}
