import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { countMp3Frames } from "../src/mp3/count-frames.js";
import { Mp3ParseError } from "../src/mp3/errors.js";
import { chunks } from "./helpers/mp3-fixtures.js";

// Committed, reviewable byte-level regressions, distinct from Jazzer's
// automatically generated corpus. Each case has an explicit expected result.
it.each([
  ["reserved-emphasis.bin", "invalid-mp3"],
  ["truncated-header.bin", "invalid-mp3"],
  ["oversized-id3-length.bin", "truncated-mp3"],
] as const)(
  "replays curated malformed input %s",
  async (filename, expectedKind) => {
    const bytes = await readFile(
      new URL(`../fuzz/regressions/raw/${filename}`, import.meta.url),
    );
    const run = (chunkSize: number) =>
      countMp3Frames(chunks(bytes, [chunkSize]));
    for (const size of [1, 17, 4096]) {
      await expect(run(size)).rejects.toMatchObject({ kind: expectedKind });
    }
  },
);

it("preserves the rejection type when a stored regression is parsed in small chunks", async () => {
  const bytes = await readFile(
    new URL("../fuzz/regressions/raw/reserved-emphasis.bin", import.meta.url),
  );
  try {
    await countMp3Frames(chunks(bytes, [3]));
    throw new Error("Expected a domain parsing error");
  } catch (error) {
    expect(error).toBeInstanceOf(Mp3ParseError);
  }
});
