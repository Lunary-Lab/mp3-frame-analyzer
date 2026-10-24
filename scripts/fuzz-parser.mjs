import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { outcome, assertSameOutcome } from "../fuzz/oracles.mjs";

/** Bounded, seeded mutation smoke test, complementary to real Jazzer fuzzing. */
const fixture = readFileSync(
  new URL("../tests/fixtures/vbr.mp3", import.meta.url),
);
let state = 0x9e3779b9;
function random(max) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) % max;
}

const cases = Number(process.env["FUZZ_CASES"] ?? "2000");
if (!Number.isInteger(cases) || cases < 1 || cases > 100_000) {
  throw new Error("FUZZ_CASES must be in the range 1..100000");
}
for (let index = 0; index < cases; index++) {
  let bytes;
  if (index % 5 === 0) {
    bytes = Buffer.alloc(random(5000));
    for (let i = 0; i < bytes.length; i++) bytes[i] = random(256);
  } else {
    bytes = Buffer.from(fixture);
    const modifications = 1 + random(20);
    for (let j = 0; j < modifications; j++)
      bytes[random(bytes.length)] = random(256);
    if (index % 7 === 0) bytes = bytes.subarray(0, random(bytes.length));
  }
  try {
    const first = await outcome(bytes, 4096);
    const second = await outcome(bytes, 1 + (index % 127));
    assertSameOutcome(first, second);
  } catch (error) {
    const directory = resolve("fuzz/crashes/raw");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, `mutation-${index}-${state >>> 0}.bin`);
    writeFileSync(file, bytes);
    console.error(`Mutation case ${index}, PRNG state ${state}, saved ${file}`);
    throw error;
  }
}
console.log(
  `Completed ${cases} seeded mutation cases with chunk-invariant outcomes`,
);
