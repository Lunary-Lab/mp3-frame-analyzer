import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { vbriFrame, withPairedTags, xingFrame, type Layout } from './helpers/encoder-layouts.js';

const base: Layout = { channel: 0, crc: false, crcShift: 0, padding: 0 };

describe('HTTP encoder-frame policy with complete ID3 records and a single MPEG frame', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(['Xing', 'Info', 'VBRI'] as const)(
    'preserves omitted/false/true policy for %s',
    async (kind) => {
      const encoder = kind === 'VBRI' ? vbriFrame(base, 3) : xingFrame(kind, 15, base);
      const payload = withPairedTags(encoder);
      for (const [query, expected] of [
        ['', 0],
        ['?includeVbrHeaderFrame=false', 0],
        ['?includeVbrHeaderFrame=true', 1],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/file-upload${query}`,
          headers: { 'content-type': 'audio/mpeg' },
          payload,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('application/json');
        expect(response.json()).toEqual({ frameCount: expected });
      }
    },
  );
});
