import { describe, expect, it } from 'vitest';

describe('ruleset probe', () => {
  it('fails on purpose so the required checks must block this pull request', () => {
    expect(1 + 1).toBe(3);
  });
});
