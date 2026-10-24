import { buildApp } from './app.js';

const portValue = process.env['PORT'] ?? '3000';
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const host = process.env['HOST'] ?? '127.0.0.1';
const app = await buildApp();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error({ err: error }, 'Server startup failed');
  process.exitCode = 1;
  await app.close();
}
