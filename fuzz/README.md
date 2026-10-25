# Coverage-guided fuzzing

Jazzer.js 4 (native libFuzzer engine, ESM instrumentation) fuzzes the compiled
MPEG parser directly. There are two targets:

- `raw.fuzz.mjs`: arbitrary and real-MP3 mutations. It asserts a valid success
  count and the **same outcome** across different stream chunk partitions.
  Arbitrary corrupt bytes have no independent frame-count oracle; this target
  cannot certify a positive count by itself.
- `structured.fuzz.mjs`: mutation bytes construct independently known frame
  boundaries for indexed and free-format MPEG-1 Layer III streams. Free-format
  uses one fixed bitrate and sample rate per stream, variable per-frame padding,
  CRC/channel flags, and 8–640 kbps cases at all three MPEG-1 sample rates.
  Optional ID3 and initial Xing/Info/VBRI metadata never supply the expected
  count. The generator records frame offsets and lengths during construction;
  its known physical-frame count makes **incorrect positive counts** detectable. It also
  knows whether the first frame is a recognized encoder frame, including
  Xing/Info shifted past a CRC, so every case is counted a second time with
  `includeVbrHeaderFrame: false` against the expected audio-frame count.
  Signatures shifted without a CRC, and valid signatures planted in a later
  frame, must stay counted.

Generated fixtures validate the structural counting contract. Their synthetic
payloads are not asserted to decode, and CRC values are not calculated. Free-format
payloads exclude sync bytes and ID3/TAG markers so this known-count oracle remains unambiguous;
arbitrary payload mutations and ambiguous short streams belong to the raw target.
A control bit also constructs one-/two-frame free-format cases. Separate flags insert complete ID3 title tags between frames and repeated footer-bearing tags before final ID3v1. Metadata headers inside MPEG frames are only inserted when a frame can hold them. The oracle tracks actual constructed boundaries rather than inferring them.

The raw target's sanity bound uses the parser's supported minimum free-format
span of 24 bytes. The previous indexed-bitrate minimum of 96 bytes incorrectly
rejected successful counts on shorter free-format frames. The fuzzer-found
`regressions/raw/free-format-three-short-frames.bin` contains three 55-byte frames;
the independently constructed 72-byte `regressions/raw/free-format-minimum.bin`
contains three 24-byte frames. Both are replayed through that oracle. Structured
seeds cover 24-byte and 2,880-byte base spans, including padding, and the
encoder-frame policy: an initial Xing frame, a lone VBRI frame (zero audio
frames), Info shifted past a CRC, the same shift without a CRC (not metadata)
and a valid Xing signature in a later frame (still counted).
`scripts/structured-fuzz.test.mjs` independently checks the generated geometry
and metadata policy as part of `npm run test:tooling`.

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
metadata issues. The three-55-byte-frame regression was found by coverage-guided
fuzzing; the minimum-span regression and structured seeds were constructed directly.
