import { createStructuredMp3 } from "./create-structured.mjs";
import { outcome } from "./oracles.mjs";

/** Structured, independent count oracle: wrong positive counts are findings. */
export async function fuzz(data) {
  const { bytes, expectedCount } = createStructuredMp3(data);
  const sizes = [1, 7, 127, 4096];
  const size = sizes[data.length ? data[0] % sizes.length : 0];
  const actual = await outcome(bytes, size);
  if (actual.kind !== "success" || actual.count !== expectedCount) {
    throw new Error(
      `Valid MPEG-1 Layer III structure: expected ${expectedCount} frames, got ${JSON.stringify(actual)}`,
    );
  }
}
