import type { FastifyInstance } from 'fastify';

/** Let in-flight requests drain, but never wait indefinitely for close hooks. */
export async function closeWithDeadline(
  app: Pick<FastifyInstance, 'close'>,
  timeoutMs = 10_000,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new Error(`Server shutdown exceeded ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
