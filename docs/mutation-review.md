# Full-parser mutation gate

## Acceptance rule

`npm run mutation` must finish with **100% adjusted mutation score** across
**every runtime TypeScript module in `src/mp3/`**, including the byte reader,
frame traversal and error class. New files are discovered automatically by
both Stryker and the auditor. This does not claim 100% mutation testing of the
HTTP adapter or the entire application.

Every generated mutant must have an audited result: freshly executed or explicitly
reused with a validated unaffected killing-test witness from a trusted baseline. Forced-full mode executes all
mutants. There are **no source-level Stryker ignores,
no excluded mutator families, and no native ignore plugin**. The raw JSON report
is preserved unchanged. The adjusted score excludes only exact, reviewed,
behaviorally equivalent mutants from its population. A reviewed equivalent that
times out remains a timeout in the raw report and raw score; it is removed from
both the adjusted detected count and denominator. The adjusted score is a
separate metric, not a rewrite of Stryker's score.

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

`scripts/run-mutations.mjs` deletes previous output reports, runs the normal
Vitest suite and Stryker, and audits the newly generated complete report with
`scripts/mutation-policy.mjs`. A new report may include explicitly accounted-for
validated reused outcomes; it is not represented as all-fresh execution.
[Cache safety and verification](mutation-cache.md) documents the trust boundary
and conservative invalidation rules. CI fails for:

- Any unexplained survivor, uncovered mutant, ignored mutant, pending result,
  compile error, runtime error, or failed Stryker process.
- An omitted parser file, an empty mutation inventory, changed source context,
  a changed toolchain version, or a stale/duplicate equivalence entry.
- An exception that no longer identifies its exact generated mutant or one
  whose supposedly equivalent mutant now fails a test.

A reviewed equivalent may finish as `Survived` with completed-test evidence or
as `Timeout` with a finite positive execution duration. A timeout alone does not
establish equivalence: the existing exact source-bound proof is still required.
Timeouts for reviewed equivalents are listed separately in
`audit.json` as `timedOutEquivalents`; they are included in the raw `timedOut`
count but excluded from both `adjustedDetected` and `adjustedTotal`. The
`equivalent` count identifies reviewed survivors, and `equivalents` lists all
reviewed identities. A test-killed equivalent still requires re-review, and
incomplete or erroneous outcomes remain failures.

The native Stryker `thresholds.break` is deliberately **0** so Stryker can emit
its unfiltered report. It is **not the acceptance threshold**. The mandatory
auditor then requires exactly 100%, with no rounding tolerance. CI invokes the
wrapper, never bare `stryker run`. Running bare Stryker is diagnostic only.

Both reports are uploaded: `reports/mutation/mutation.json` (raw) and
`reports/mutation/audit.json` (adjusted, with explicit counts, exception IDs,
and executed/reused accounting). Test-process logs and input fingerprints are
uploaded beside them. The unmodified Stryker schema stays at 1.0 and the
equivalence policy at 1; only the separate audit adds an `execution` object.
A failed run cannot reuse a stale passing audit. Mutation jobs run for pull
requests, pushes to `main`, manual dispatches, and a weekly forced-full run.
Normal PRs can reuse validated unaffected kills from an exact-base trusted-main
baseline. Releases and weekly verification always execute all mutants.

## Evidence and compatibility

The measurements below come from the completed full local campaign combining
PR #9 at `7e676dcb29327fa2673a422d274b87584c0b6ea6` with the queue cursor and
independent free-format validation changes. That campaign ran the full test
suite with four workers, `timeoutMS: 5000` and a 20-minute process
watchdog. Its original raw and audited reports are preserved unchanged.

The final checkout starts from main at
`5e0f0f8574d312ccb5d925549bd1720db14b426b`. All seven parser source files are
byte-for-byte identical to the completed campaign. A separate audit of that
original report against the final parser sources and exact policy passes; it
is source-evidence reuse, not a second mutation campaign. The changed HTTP
counting default is outside `src/mp3`; its raw and multipart behavior is
verified by HTTP tests, including the supplied sample when available.

The current mutation runner uses only parser test files and two workers.
Stryker's unchanged `timeoutMS: 2000` is an additional allowance: its effective
per-mutant timeout is the measured baseline net duration multiplied by the
default factor 1.5, plus that allowance and measured overhead. It is not a hard
two-second limit.

PR #20's first CI run reached 464 of 704 mutants before the former 30-minute
wrapper limit terminated it; Stryker estimated about 45 minutes for completion.
The wrapper now permits 60 minutes, with a 65-minute CI job limit for setup
and report upload. These finite whole-run limits are separate from Stryker's
per-mutant timeout policy.

The historical command runner used Vitest's `--bail=1`: one failing test already detects
the active mutant, so remaining tests need not run for that mutant. The
then-current unmodified baseline and every surviving mutant ran the complete
parser test selection. The native runner now uses coverage-based test selection. Every parser mutant remains in scope, and the 100%
adjusted score requirement is unchanged. A fresh CI invocation generates and
audits its own reports; the historical result below does not substitute for
that CI run. The original timed-out run is retained in
[GitHub Actions](https://github.com/Lunary-Lab/mp3-frame-analyzer/actions/runs/40142842959).

### Parser-only CI campaign and timeout accounting

The subsequent [PR #20 campaign](https://github.com/Lunary-Lab/mp3-frame-analyzer/actions/runs/40145577143)
completed all **704 mutants** in **29 minutes 9 seconds**: **638 killed,
36 timed out and 30 survived**, for **95.74% raw**. All 30 survivors match exact
reviewed equivalents. Two other reviewed equivalents, `EQ-FREE-PRECHECK` and
`EQ-FREE-DISTINCT-BASE`, timed out after 7,759 and 7,764 ms respectively. Their
source and proofs are unchanged. The first chain step repeats the pre-check,
and successive candidate bases remain distinct.

That run failed its audit because the original policy implementation required
every reviewed equivalent to have the `Survived` status. The corrected auditor
preserves both timeout outcomes and explicitly removes those two known
equivalents from the adjusted detected count as well as its denominator.
The unchanged raw report therefore has **672/672 adjusted detection**, with
**32 reviewed equivalents** split into 30 survivors and two timeouts. No policy
entry, parser source, test selection, mutation scope or timeout setting changes
for this accounting correction. A fresh CI run must still complete and audit
its own full report before merge.

### Free-format header precedence fix

Checking invalid and unsupported headers before the bitrate-mode mixing rule
changed only `frame-spans.ts`, which had no equivalents. A local campaign
generated **644 mutants: 593 killed, 24 timed out and 27 reviewed
equivalents**, for **95.81% raw** and **617/617 adjusted**. All 55
`frame-spans.ts` mutants are killed; the 27 entries cover unchanged files and
were reused verbatim, so only the context hash changed.

### Frame-span refactor

[ADR 0004](adr/0004-frame-spans-resolve-from-one-header-decode.md) replaced the
header predicates with one decoder, added `frame-spans.ts`, renamed
`vbr-header.ts` to `encoder-frame.ts` and changed `free-format.ts`,
`encoder-frame.ts` and `count-frames.ts`. A local campaign
generated **655 mutants: 604 killed, 24 timed out and 27 reviewed
equivalents**, for **95.88% raw** and **628/628 adjusted**. The new decoder and
resolver have no equivalents. `EQ-FREE-COMPAT-LENGTH-GUARD` and
`EQ-FREE-COMPAT-LENGTH-SUBTRACT` disappeared: the probe-window bound is now the
only guard against reading a cut-off header, and decoding no longer implies
the free-format check. Two tests kill the new mutants: a header cut off by the
end of the stream (the bound) and an indexed header (the free-format check)
must not break a tie between candidate spans. The other 17 entries in changed files were re-reviewed: the cleanup and
free-format proofs hold with renamed variables, and the ten `encoder-frame.ts`
proofs now state that `isEncoderFrame` receives a decoded header and exactly
one frame's span.

### ID3 placement refactor

[ADR 0003](adr/0003-the-id3-module-owns-tag-placement.md) moved tag placement
rules from `count-frames.ts` into `id3.ts`, changing both files and the parser
context hash. A local campaign on the changed tree generated **683 mutants:
627 killed, 27 timed out and 29 reviewed equivalents**, for **95.75% raw** and
**654/654 adjusted**. Three equivalents disappeared with the code that needed
them: `EQ-ID3-LEADING-PLACEMENT` (placement is no longer a string argument) and
`EQ-ID3V2-LENGTH-GUARD` / `EQ-ID3V1-LENGTH-GUARD` (the redundant signature
length guards are gone). `EQ-CLEANUP-INITIAL-FLAG`, `EQ-CLEANUP-CONDITION`,
`EQ-CLEANUP-SUCCESS` and `EQ-ID3V2-FOOTER-VERSION` were re-reviewed against the
new source; their reasoning holds, and two proofs now name the new functions.
The synchsafe-size check became a `findIndex` over the copied header. Its old
`i < 10` loop bound was killed only by a direct decoder test that passed more
than ten bytes; through `countMp3Frames` that mutant would have been
equivalent, so the check now takes its bound from the header bytes instead. The other 25 entries cover
unchanged files and were reused verbatim.

### Historical campaign totals

| Module            | Mutants |  Killed | Timed out | Reviewed equivalents |
| ----------------- | ------: | ------: | --------: | -------------------: |
| `byte-reader.ts`  |     148 |      89 |        50 |                    9 |
| `count-frames.ts` |     172 |     146 |        22 |                    4 |
| `errors.ts`       |       2 |       1 |         1 |                    0 |
| `frame-header.ts` |      77 |      51 |        26 |                    0 |
| `free-format.ts`  |      75 |      58 |        11 |                    6 |
| `id3.ts`          |      96 |      91 |         2 |                    3 |
| `vbr-header.ts`   |     134 |     124 |         0 |                   10 |
| **Total**         | **704** | **560** |   **112** |               **32** |

Raw score: **95.45%**; adjusted score: **100%**. All 32 survivors match exact
reviewed equivalents. Timeouts are reported separately from assertion kills;
their split can vary with the machine's scheduling.

The preceding merged PR #9 campaign recorded 694 mutants: 632 killed,
34 timed out and 28 reviewed equivalents, for 95.97% raw and 100% adjusted.
Its earlier full-suite run detected the same 666 mutants, split as 560 killed
and 106 timed out. Earlier testing in that work found and killed 46
non-equivalent survivors with boundary tests:

- Xing optional fields that exactly fill a frame, or fall one byte short.
- Partial and wrong signatures.
- VBRI fields read despite filled side information, and an exactly fitting TOC
  with one-byte entries.
- CRC-only Xing placement, and frame-sized buffers.
- Free-format span limits: 23, 24, 2,880 and 2,881 bytes.
- The three-frame minimum and the probe-window edge.
- Traversal error messages.

The queue cursor introduced seven new survivors in an initial reader-only
diagnostic. Three removed necessary queue storage cleanup: deleting the empty
queue reset, disabling nonempty-prefix compaction, or deleting that compaction
body. They were **not** treated as equivalent. Two lifetime regressions now
exercise repeated empty-queue refill and a continuously buffered queue. Each
reuses one source byte, warms the reader, then measures live heap after another
400,000 reads and garbage collection. This isolates queue bookkeeping from
payload allocation and detects unbounded retention of consumed slots. A focused
mutation rerun killed all three cleanup faults; the full campaign above includes
those tests.

The five existing byte-reader copy-loop proofs were re-reviewed against the
active queue suffix before their source hashes and locations were updated.
Consumed entries lie before `headIndex` and are cleared immediately; active
entries remain defined, their order is unchanged by compaction, and `available`
is their total remaining byte count. The other modules' source and their
dependent cleanup assumptions were checked before updating the full parser
context hash.

The 32 equivalents fall into six groups. Every entry in
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
- **Queue compaction timing**, where the exact mutation still clears consumed
  payload references and preserves bytes, offsets, errors, iterator lifecycle
  and a constant bound on retained queue slots: `EQ-QUEUE-*`. These four proofs
  cover deferring the empty-queue fast path to the existing threshold, compacting
  after every consumed chunk, delaying compaction by one slot, and an inverted
  threshold that inductively performs the same eager compaction. Their costs
  can differ; equivalence does not promise identical instruction counts or
  throughput. Performance measurements remain separate from the functional and
  bounded-storage mutation score.
