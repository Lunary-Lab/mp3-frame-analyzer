# Coverage-guided fuzzing

Jazzer.js 4 (native libFuzzer engine, ESM instrumentation) fuzzes the compiled
MPEG parser directly. There are two targets:

- `raw.fuzz.mjs`: arbitrary and real-MP3 mutations. It asserts a valid success
  count and the **same outcome** across different stream chunk partitions.
  Arbitrary corrupt bytes have no independent frame-count oracle; this target
  cannot certify a positive count by itself.
- `structured.fuzz.mjs`: mutation bytes construct an independent, always-valid
  MPEG-1 Layer III stream with variable bitrates, sample rates, CRC, padding,
  synthetic payloads and ID3 tags. Its known expected physical-frame count
  makes **incorrect positive counts** detectable.

## Commands

```bash
npm ci
npm run fuzz:regression       # replay seeded and saved cases, no mutation
npm run fuzz:coverage         # 8 seconds per target, coverage-guided
npm run fuzz:extended         # 120 seconds per target, manual/CI dispatch
npm run test:fuzz             # fast deterministic mutation smoke + reducer tests
```

Each fuzz input has a Jazzer-enforced **2-second timeout**; the wrapper imposes
an independent hard process deadline of campaign duration plus 35 seconds.
Fuzz inputs are limited to 64 KiB and the native fuzzer has a 768 MiB RSS cap.
CI only runs the short campaign; `.github/workflows/fuzz.yml` allows a longer,
on-demand run. All nonzero exits fail CI.

## Reproducing, minimizing, and retaining crashes

Jazzer saves corpus improvements to `.fuzz-corpus/` (gitignored) and crashes
to `fuzz/crashes/<target>/` (gitignored, uploaded as CI artifacts). A failed
campaign attempts bounded **delta debugging** on up to three crashes:

```bash
node scripts/minimize-fuzz-crash.mjs raw fuzz/crashes/raw/crash-<digest>
```

A minimizer preserves the same failure class using isolated child processes
with 1.2-second per-probe timeouts, at most 180 candidate executions and a
22-second overall reduction budget. The minimized input stays under
`fuzz/crashes/` for human inspection. Promote a confirmed fix by copying its
minimized input to `fuzz/regressions/<target>/`, adding a Vitest assertion of
expected behavior to `tests/fuzz-regressions.test.ts`, and committing both.
Never silently regard an arbitrary positive count as correct. If the replay
subprocess fails without a recognized fuzz-failure marker (for example, an
unavailable runtime or exit 127), minimization fails closed and preserves the
original crash artifact instead of producing a misleading minimized result.

To replay a crash in Jazzer itself:

```bash
./node_modules/.bin/jazzer fuzz/raw.fuzz.mjs --mode=regression --includes=dist/mp3/ fuzz/crashes/raw/crash-<digest>
```

The repository includes committed regression examples for known header and
metadata issues. It does **not** claim the fixtures were discovered by Jazzer.
