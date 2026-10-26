import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { frame, multipartBody } from './helpers/mp3-fixtures.js';

it.each([NaN, 400.5, 499.5, 400, 499])(
  'applies the sanitized framework-status contract for %s over HTTP',
  async (statusCode) => {
    const app = await buildApp();
    const error = Object.assign(new Error('Private hook diagnostic'), { statusCode });
    const logError = vi.fn();
    // Model a library/hook failure, not an upload-controlled status property.
    app.addHook('preHandler', async (request) => {
      request.log.error = logError;
      throw error;
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const raw = { payload: frame(), contentType: 'audio/mpeg' };
      const multipart = multipartBody(frame());
      for (const { payload, contentType } of [raw, multipart]) {
        logError.mockClear();
        const response = await fetch(`${address}/file-upload`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: new Uint8Array(payload),
          signal: AbortSignal.timeout(2_000),
        });
        const valid = Number.isInteger(statusCode);
        expect(response.status).toBe(valid ? statusCode : 500);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toEqual(
          valid
            ? { error: 'invalid-request', message: 'Invalid HTTP request' }
            : { error: 'internal-error', message: 'Unable to process upload' },
        );
        if (valid) expect(logError).not.toHaveBeenCalled();
        else expect(logError).toHaveBeenCalledWith({ err: error }, 'Unexpected upload failure');
      }
    } finally {
      await app.close();
    }
  },
);
