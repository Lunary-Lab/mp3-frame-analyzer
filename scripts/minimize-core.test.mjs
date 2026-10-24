import { test } from "node:test";
import { strict as assert } from "node:assert";
import { minimizeBytes } from "./minimize-core.mjs";
import { classifyReplayProcess } from "./classify-replay.mjs";

test("delta debugging preserves a failure and removes irrelevant bytes", async () => {
  const result = await minimizeBytes(
    Buffer.from("xxxxCRASHyyyy"),
    async (bytes) => bytes.includes(Buffer.from("CRASH")),
    { maxProbes: 100, budgetMs: 5_000 },
  );
  assert.equal(result.bytes.toString(), "CRASH");
  assert.ok(result.probes > 0);
});

test("minimization rejects non-reproducing input", async () => {
  await assert.rejects(
    minimizeBytes(Buffer.from("safe"), async () => false),
    /does not reproduce/,
  );
});

test("replayer accepts known parser failures, clean runs and timeouts", () => {
  assert.equal(
    classifyReplayProcess({
      status: 1,
      stderr: 'FUZZ_FAILURE {"name":"Error","family":"chunk-invariance"}\n',
    }),
    "Error:chunk-invariance",
  );
  assert.equal(classifyReplayProcess({ status: 0, stderr: "" }), null);
  assert.equal(
    classifyReplayProcess({ status: null, error: { code: "ETIMEDOUT" } }),
    "timeout",
  );
});

test("replayer fails closed on infrastructure errors and invalid failure markers", () => {
  assert.throws(
    () => classifyReplayProcess({ status: 127, stderr: "node not found" }),
    /without a recognized failure marker/,
  );
  assert.throws(
    () =>
      classifyReplayProcess({
        status: null,
        error: { code: "ENOENT", message: "node missing" },
      }),
    /could not launch/,
  );
  assert.throws(
    () => classifyReplayProcess({ status: 1, stderr: "FUZZ_FAILURE not-json" }),
    /without a recognized failure marker/,
  );
  assert.throws(
    () =>
      classifyReplayProcess({
        status: 1,
        stderr: 'FUZZ_FAILURE {"name":"Error"}',
      }),
    /incomplete failure marker/,
  );
});
