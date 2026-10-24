# Full-parser mutation gate

## Acceptance rule

`npm run mutation` must finish with **100% adjusted mutation score** across
**every runtime TypeScript module in `src/mp3/`**, including the byte reader,
frame traversal and error class. New files are discovered automatically by
both Stryker and the auditor. This does not claim 100% mutation testing of the
HTTP adapter or the entire application.

Every generated mutant is executed. There are **no source-level Stryker ignores,
no excluded mutator families, and no native ignore plugin**. The raw JSON report
is preserved unchanged. The adjusted score excludes only exact, reviewed,
behaviorally equivalent survivors from its denominator; it is a separate metric,
not a rewrite of Stryker's score.

## Why not `Stryker disable next-line ConditionalExpression`?

That annotation can suppress both `true` and `false` replacements on a condition,
including a meaningful mutation beside an equivalent one. The supported
[disable-mutants documentation](https://stryker-mutator.io/docs/stryker-js/disable-mutants/)
describes this mutator-level granularity. We instead match an exception to its
file, source hash, source range, original expression, mutator, and **exact
replacement**. No neighboring mutation is exempted.

## How the gate fails closed

`mutation-equivalents.json` is the reviewed policy; its **full parser context
hash** also binds proofs that depend on another module's invariants. Any parser
change requires re-reviewing those assumptions before updating that hash.

`scripts/run-mutations.mjs` deletes previous reports, runs Stryker, and audits the
fresh complete report with `scripts/mutation-policy.mjs`. CI fails for:

- Any unexplained survivor, uncovered mutant, ignored mutant, pending result,
  compile error, runtime error, or failed Stryker process.
- An omitted parser file, an empty mutation inventory, changed source context,
  a changed toolchain version, or a stale/duplicate equivalence entry.
- An exception that no longer identifies its exact generated mutant or one
  whose supposedly equivalent mutant now fails a test.

The native Stryker `thresholds.break` is deliberately **0** so Stryker can emit
its unfiltered report. It is **not the acceptance threshold**. The mandatory
auditor then requires exactly 100%, with no rounding tolerance. CI invokes the
wrapper, never bare `stryker run`. Running bare Stryker is diagnostic only.

Both reports are uploaded: `reports/mutation/mutation.json` (raw) and
`reports/mutation/audit.json` (adjusted, with explicit counts and exception IDs).
A failed run cannot reuse a stale passing audit. Mutation jobs run for pull
requests, pushes to `main`, and manual dispatches.

## Evidence and compatibility

The measurements below come from the full campaign on the parser after PRs
#8, #13 and #16 (raw and audit reports are CI artifacts).

| Module            | Mutants |  Killed | Timed out | Reviewed equivalents |
| ----------------- | ------: | ------: | --------: | -------------------: |
| `byte-reader.ts`  |     138 |     116 |        17 |                    5 |
| `count-frames.ts` |     172 |     166 |         2 |                    4 |
| `errors.ts`       |       2 |       2 |         0 |                    0 |
| `frame-header.ts` |      77 |      74 |         3 |                    0 |
| `free-format.ts`  |      75 |      58 |        11 |                    6 |
| `id3.ts`          |      96 |      92 |         1 |                    3 |
| `vbr-header.ts`   |     134 |     124 |         0 |                   10 |
| **Total**         | **694** | **632** |    **34** |               **28** |

The mutation command runs the parser test files with a 2-second per-mutant
timeout, because the mutation scope is `src/mp3`. Running the whole suite,
including HTTP adapter tests that start servers and processes, detected exactly
the same mutants. That run took 14 m 49 s locally, compared with 5 m 41 s now,
and exceeded the CI wall clock. The wrapper's limit is 30 minutes.

Raw score: **95.97%**; adjusted score: **100%**. The first run on the combined
tree scored 89.77% raw. Its 46 non-equivalent survivors were killed with
boundary tests:

- Xing optional fields that exactly fill a frame, or fall one byte short.
- Partial and wrong signatures.
- VBRI fields read despite filled side information, and an exactly fitting TOC
  with one-byte entries.
- CRC-only Xing placement, and frame-sized buffers.
- Free-format span limits: 23, 24, 2,880 and 2,881 bytes.
- The three-frame minimum and the probe-window edge.
- Traversal error messages.

The 28 equivalents fall into five groups. Every entry in
[`mutation-equivalents.json`](../mutation-equivalents.json) records the exact
mutant, its source hash, assumptions and proof.

- **Redundant length guards** before typed-array reads, where an out-of-range
  index yields `undefined` and fails the comparison anyway: `EQ-ID3V2-*`,
  `EQ-ID3V1-*`, `EQ-FREE-COMPAT-*`, `EQ-VBR-TEXT-*`, `EQ-XING-FLAGS-*`,
  `EQ-VBRI-LENGTH-*`.
- **Byte-reader copy-loop bounds**, already guaranteed by `peek()`'s length
  check: `EQ-COPY-*`.
- **Idempotent success-path cleanup** of an ended reader: `EQ-CLEANUP-*`.
- **Unobservable control values**: the initial tie flag, distinct candidate
  bases, a pre-check repeated by the chain's first step, sub-threshold
  candidates, and an unused placement label (`EQ-FREE-TIED-INITIAL`,
  `EQ-FREE-DISTINCT-BASE`, `EQ-FREE-PRECHECK`, `EQ-FREE-MIN-MATCH-FILTER`,
  `EQ-ID3-LEADING-PLACEMENT`).
- **Flag-word arithmetic**, where validation accepts only words with zero
  high bytes: `EQ-VBR-U32-*`. An exhaustive byte-level check confirmed it.
