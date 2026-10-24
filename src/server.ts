import { buildApp } from './app.js';
import { closeWithDeadline } from './shutdown.js';

const portValue = process.env['PORT'] ?? '3000';
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const host = process.env['HOST'] ?? '127.0.0.1';
const app = await buildApp();

let closing: Promise<void> | undefined;
function shutdown(): Promise<void> {
  closing ??= closeWithDeadline(app).catch((error: unknown) => {
    app.log.error({ err: error }, 'Server shutdown failed');
    // This is the last resort after a failed close or exhausted drain deadline.
    process.exit(1);
  });
  return closing;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error({ err: error }, 'Server startup failed');
  process.exitCode = 1;
  await shutdown();
}
