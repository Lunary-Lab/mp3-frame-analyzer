import { createSequenceMp3 } from './create-sequences.mjs';
import { countMp3Frames } from '../dist/mp3/count-frames.js';
import { Mp3ParseError } from '../dist/mp3/errors.js';
import { chunks, assertSameOutcome } from './oracles.mjs';

async function observe(bytes, size, includeVbrHeaderFrame) {
  try {
    const count = await countMp3Frames(chunks(bytes, size), { includeVbrHeaderFrame });
    const minimum = includeVbrHeaderFrame ? 1 : 0;
    if (!Number.isSafeInteger(count) || count < minimum || count * 21 > bytes.length) {
      throw new Error(`Impossible sequence count: ${count} for ${bytes.length} bytes`);
    }
    return { kind: 'success', count };
  } catch (error) {
    if (!(error instanceof Mp3ParseError)) throw error;
    return { kind: 'rejection', code: error.kind, offset: error.offset, message: error.message };
  }
}

function assertCountPolicies(whole, excluded, domain) {
  // Arbitrary payloads can contain a recognized initial encoder structure.
  // Compare chunking under each policy; only a single initial frame may differ.
  if (domain === 'structural' && whole.kind === 'success' && excluded.kind === 'success') {
    if (whole.count - excluded.count < 0 || whole.count - excluded.count > 1) {
      throw new Error('Invalid initial encoder-frame exclusion');
    }
  } else {
    assertSameOutcome(whole, excluded);
  }
}

/** Exact-count subdomains and known ambiguity are separate from arbitrary layouts. */
export async function fuzz(data) {
  const fixture = createSequenceMp3(data);
  if (fixture.bytes.length > 81_000) throw new Error('Unbounded sequence construction');
  const size = [1, 7, 257, 4096][data.length ? data[0] % 4 : 0];
  const whole = await observe(fixture.bytes, fixture.bytes.length, true);
  assertSameOutcome(whole, await observe(fixture.bytes, size, true));
  const excluded = await observe(fixture.bytes, fixture.bytes.length, false);
  assertSameOutcome(excluded, await observe(fixture.bytes, size, false));
  assertCountPolicies(whole, excluded, fixture.expectation.kind);
  if (fixture.expectation.kind === 'count') {
    if (whole.kind !== 'success' || whole.count !== fixture.expectation.count) {
      throw new Error(`Sequence count ${fixture.expectation.count}: got ${JSON.stringify(whole)}`);
    }
  } else if (fixture.expectation.kind === 'ambiguous') {
    if (
      whole.kind !== 'rejection' ||
      whole.code !== 'unsupported-format' ||
      whole.message !== 'Ambiguous free-format MPEG frame layout'
    ) {
      throw new Error(`Expected explicit sequence ambiguity: got ${JSON.stringify(whole)}`);
    }
  }
}
