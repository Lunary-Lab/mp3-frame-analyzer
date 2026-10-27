import { expect, it } from 'vitest';
import { ClientError } from '../src/client-error.js';

it('preserves the deliberate error identity and sanitized public fields', () => {
  const error = new ClientError(409, 'conflict', 'Safe diagnostic');
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('ClientError');
  expect(error.message).toBe('Safe diagnostic');
  expect(error.status).toBe(409);
  expect(error.code).toBe('conflict');
  expect(error.closeConnection).toBe(false);
});

it.each([false, true])('retains the explicit connection-close decision %s', (closeConnection) => {
  expect(
    new ClientError(400, 'invalid-option', 'Invalid option', { closeConnection }).closeConnection,
  ).toBe(closeConnection);
});
