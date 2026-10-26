import type { FastifyInstance } from 'fastify';

/** Reap connections that become idle after shutdown starts, without interrupting uploads. */
export function closeIdleConnectionsAfterDrain(app: FastifyInstance): void {
  let closing = false;
  const reapIdle = () => {
    if (closing) app.server.closeIdleConnections();
  };
  app.addHook('preClose', (done) => {
    closing = true;
    done();
  });
  app.addHook('onRequest', (request, _reply, done) => {
    // An early error response can precede request EOF, even before shutdown.
    // Recheck both completion boundaries; neither implies the other is done.
    const detach = () => request.raw.off('end', reapIdle);
    request.raw.once('end', reapIdle);
    request.raw.once('close', detach);
    done();
  });
  app.addHook('onResponse', (_request, _reply, done) => {
    // server.close() already reaps existing idle sockets. An accepted request
    // can finish later; Node's idle-only API preserves every still-active one.
    reapIdle();
    done();
  });
}

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
