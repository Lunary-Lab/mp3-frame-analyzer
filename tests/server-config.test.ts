import { expect, it } from 'vitest';
import {
  maxUploadBytesFromEnvironment,
  maxMultipartBytesFromEnvironment,
} from '../src/server-config.js';

it('retains the 50 MiB default only when MAX_UPLOAD_BYTES is absent', () => {
  expect(maxUploadBytesFromEnvironment(undefined)).toBe(50 * 1024 * 1024);
});

it.each([
  ['1', 1],
  ['835', 835],
  ['000835', 835],
  ['52428800', 50 * 1024 * 1024],
  ['104857600', 100 * 1024 * 1024],
  ['9007199254740991', Number.MAX_SAFE_INTEGER],
])('accepts decimal MAX_UPLOAD_BYTES %s as %s bytes', (value, expected) => {
  expect(maxUploadBytesFromEnvironment(value)).toBe(expected);
});

it.each([
  '',
  ' ',
  '\t',
  '0',
  '000',
  '-1',
  '+1',
  '1.5',
  '1.0',
  '.5',
  '1e3',
  '0x100',
  '0b10',
  '0o10',
  'NaN',
  'Infinity',
  'unlimited',
  '50MiB',
  '1_000',
  '1,000',
  ' 835',
  '835 ',
  '835\n',
  '\n835',
  '８３５',
  '9007199254740992',
  '9007199254740993',
  '9'.repeat(400),
])('rejects invalid MAX_UPLOAD_BYTES %j without coercion or fallback', (value) => {
  expect(() => maxUploadBytesFromEnvironment(value)).toThrow(
    'MAX_UPLOAD_BYTES must be a positive safe integer in decimal bytes (1 to 9007199254740991)',
  );
});

it('derives the aggregate multipart default from the configured per-file limit', () => {
  expect(maxMultipartBytesFromEnvironment(undefined, 835)).toBe(835 + 65536);
  expect(maxMultipartBytesFromEnvironment(undefined, Number.MAX_SAFE_INTEGER)).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

it('accepts a separate aggregate multipart limit even below the per-file limit', () => {
  expect(maxMultipartBytesFromEnvironment('000512', 1024)).toBe(512);
});

it.each(['', '0', '-1', '1.5', '1e3', ' 512', '512\n', '9007199254740992'])(
  'rejects invalid MAX_MULTIPART_BYTES %j without falling back',
  (value) => {
    expect(() => maxMultipartBytesFromEnvironment(value, 1024)).toThrow(
      'MAX_MULTIPART_BYTES must be a positive safe integer in decimal bytes',
    );
  },
);
