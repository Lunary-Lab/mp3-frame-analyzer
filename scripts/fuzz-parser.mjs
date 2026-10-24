import { readFileSync } from 'node:fs';
import { countMp3Frames } from '../dist/mp3/count-frames.js';
import { Mp3ParseError } from '../dist/mp3/errors.js';

// Seeded mutation fuzz smoke test. Not a coverage-guided fuzzer: fast-check
// covers structured inputs in CI; extend with Jazzer.js for a long campaign.
const fixture = readFileSync(new URL('../tests/fixtures/vbr.mp3', import.meta.url));
let state = 0x9e3779b9;
function random(max) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) % max;
}

async function* stream(buffer) {
  let index = 0;
  while (index < buffer.length) {
    const end = Math.min(buffer.length, index + 1 + random(3000));
    yield buffer.subarray(index, end);
    index = end;
  }
}

const cases = Number(process.env.FUZZ_CASES ?? '2000');
if (!Number.isInteger(cases) || cases < 1 || cases > 100_000) {
  throw new Error('FUZZ_CASES must be in the range 1..100000');
}
for (let caseIndex = 0; caseIndex < cases; caseIndex++) {
  let bytes;
  if (caseIndex % 5 === 0) {
    bytes = Buffer.alloc(random(5000));
    for (let i = 0; i < bytes.length; i++) bytes[i] = random(256);
  } else {
    bytes = Buffer.from(fixture);
    const modifications = 1 + random(20);
    for (let j = 0; j < modifications; j++) {
      bytes[random(bytes.length)] = random(256);
    }
    if (caseIndex % 7 === 0) bytes = bytes.subarray(0, random(bytes.length));
  }
  try {
    const frames = await countMp3Frames(stream(bytes));
    if (!Number.isSafeInteger(frames) || frames < 1) {
      throw new Error(`Impossible frame count ${frames}`);
    }
  } catch (error) {
    if (!(error instanceof Mp3ParseError)) {
      console.error(`Unexpected exception at mutation case ${caseIndex}, seed state ${state}`);
      throw error;
    }
  }
}
console.log(`Completed ${cases} seeded mutation cases without unexpected exceptions`);
