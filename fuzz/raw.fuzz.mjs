import { outcome, assertSameOutcome } from "./oracles.mjs";

/** Coverage-guided byte-level mutation target, instrumenting dist/mp3. */
export async function fuzz(data) {
  const bytes = Buffer.from(data);
  const first = await outcome(bytes, 4096);
  const size = bytes.length <= 1024 ? 1 : 127;
  const second = await outcome(bytes, size);
  assertSameOutcome(first, second);
}
