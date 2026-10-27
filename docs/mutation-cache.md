# Native mutation-result reuse

Stryker 10.1.1 owns incremental matching, current mutation discovery, test
coverage, and result reuse. We do not maintain a JavaScript purity analyzer,
import graph, killing-witness database, or a rewritten/pruned mutation report.
The separate [equivalent-mutant audit](mutation-review.md) still requires the
complete parser scope, exact source-bound equivalence approvals and **100%
adjusted score**. An unexplained survivor still fails.

## What runs

`npm run mutation` always runs the full ordinary Vitest suite, followed by
Stryker's full configured `src/mp3/**/*.ts` discovery and fresh coverage dry run.
A compatible completed baseline is supplied unchanged through Stryker's native
`incrementalFile`. Otherwise `--force` executes every current mutant. We do not
narrow `--mutate` on this ordinary path or preserve an old inventory in place of
current discovery. `npm run mutation:full` remains a single fresh local campaign.

Scheduled CI, full manual CI and exact-source release validation instead use the
native GitHub matrix in `.github/workflows/mutation.yml`. Node's filesystem glob
discovers every parser source; sorted whole files are assigned round-robin to at
most 11 nonempty parser jobs. The existing pure-runtime campaign occupies the
twelfth mutation slot. This ceiling is not a measured optimum or a cap on other
CI jobs. Each parser job retains two Stryker workers, the ordinary full Vitest
suite, native parser-test discovery and a fresh Stryker coverage dry run.

The reusable workflow checks out the immutable event SHA and rejects a caller ref
that differs before running repository code. Release preflight already binds the
requested source to that tagged event; PR, main, scheduled and manual CI use their
event SHA. Caller inputs cannot select other code within the event's cache scope.

Fresh jobs remove native working state before `--force --mutate`, because force
alone can retain out-of-scope results from an old incremental report. They never
restore or publish mutation-result caches. The collector checks every assigned
file exactly once, current source/test bytes, common configuration and declared
inputs, clean process completion, run/attempt/commit identity and artifact/report
digests. It applies the existing source-bound equivalent proofs and 100% adjusted
policy across unchanged raw reports, resolving test IDs within each report.
GitHub can assign different image revisions within a fresh matrix. Full collection
requires the same image family, platform, architecture and Node/component versions,
but permits different image revisions; each raw manifest retains its exact revision.
This exception applies only to fresh full runs, never to cached-result admission.
Missing, duplicate, stale, failed or inconsistent evidence fails the full gate.
Rerun **all jobs** after a partial failure; artifacts from an older attempt cannot
complete a newer one. Raw `full-parser-shard-<attempt>-<index>` artifacts and the
`full-parser-mutation-report-<attempt>` audit remain separate; no merged report is
constructed for Stryker or the cache.

The collector repeats native file discovery to require every owned parser suite,
then uses Vitest's runnable-test discovery for report file coverage. This permits
native all-skipped suites (such as an absent optional external sample) without a
filename exception; every runnable suite must appear consistently in every shard.

Ordinary PR/main runs, including cache misses, retain the single-runner path.
File workloads may be uneven; runner count alone does not establish a latency
guarantee. The short native regression in `scripts/full-mutations.integration.test.mjs`
checks the real runner/collector, fresh state, changed inputs and failed evidence.

Native reuse includes killed, timeout and reviewed-equivalent outcomes. It is
not fresh execution: reused native records omit `duration`. The audit permits an
omitted timeout duration only after admitting a compatible completed baseline;
fresh timeouts still need a positive finite duration. No duration is fabricated.
The report is not modified to turn survivors into kills. `audit.json` records
fresh/reused counts, source commit, key, elapsed time and cache reason.

## Small declared-input boundary

The key includes filenames, modes and contents of tracked and nonignored
untracked project files, Node/component versions, platform/architecture, hosted
runner image, the bounded child environment, and any explicitly supplied
`ASSESSMENT_SAMPLE_PATH` bytes. Root Vite `.env`, `.env.local`, `.env.test` and
`.env.test.local` files are included even when ignored by Git. CI installs the
exact lockfile with `npm ci --ignore-scripts`; we do not recursively hash
`node_modules`.

The only noninputs are named root documentation files, Markdown under `docs/`
(except `docs/mutation-review.md`), governance files, the four named runtime
architecture scanner/test scripts and `tests/runtime-architecture/` fixtures,
the Copilot instructions, and the parent `ci.yml`. These SAST-only files are not
inputs to the parser mutation tests; other scripts remain keyed. The parent's exact
mutation job is checked against `scripts/mutation-job-contract.json`, which
**is** a keyed input; the mutation composite/setup actions and scripts are keyed.
Thus changing an unrelated CI job does not invalidate results, but changing the
mutation checkout, runner, setup, permissions or invocation contract does.
The actual bounded child environment remains keyed independently.

All parser and nonparser source, selected tests, helpers, imported modules,
resources (including Markdown fixtures), configuration, plugins and lockfile
changes conservatively force full execution. Native test-span matching cannot
safely cover every changed top-level helper or static mutant by itself. This v1
chooses a small conservative boundary rather than selective dependency analysis.
Docs and unrelated SAST/CI edits are fast cases; arbitrary nonparser code edits
are **not** promised to be fast.

This is a deterministic-input contract, not proof of arbitrary JavaScript
purity. Manual installed-package edits, custom Vite env directories/modes,
undeclared ignored resources, network responses, clock/randomness and arbitrary
external reads are not supported cache inputs. Use `mutation:full` for such
experiments and declare new deterministic inputs before enabling reuse.
`NODE_OPTIONS`, unreadable or unsupported nonregular inputs disable reuse.
Any detected input change during execution fails and prevents promotion.

### Why changed tests force a fresh run

A local diagnostic with pinned Stryker **10.1.1** (2026-10-27) kept the same 224
nonparser mutant identities and source bytes while adding 26 tests (75 → 101).
Direct native incremental execution retained **61 static survivors** that the
following fresh run, with the identical 101 tests, killed. This demonstrates
**stale-red results** (an outdated lower score), not an unsafe passing result.
It is a diagnostic native-tool observation, not an accepted production baseline
or a claim about a different, subsequently refactored mutation inventory.

The [pinned incremental differ](https://github.com/stryker-mutator/stryker-js/blob/959127763e5bbe2eb65f5341a8161780d6d8a476/packages/core/src/mutants/incremental-differ.ts#L428-L470)
uses coverage changes when deciding whether to retain non-killed outcomes;
static results may lack per-test coverage. Our declared-input key therefore
forces full execution when tests/helpers change instead of adding a custom
per-mutant refresh engine. Missing duration alone is not a universal reuse
indicator: erroneous native outcomes can omit it too, and the gate rejects those
outcomes before counting accepted fresh/reused results.

## Local and CI provenance

A local successful audited run saves a `sourceCommit: local` baseline; subsequent
same-key local invocations can reuse it. Local files are trusted as local user
state, not as authenticated CI evidence. Interrupted/failed runs never promote
working results, and concurrent invocations are rejected by the existing lock.

CI first removes workspace cache files. A small read-only GitHub API selector
looks among the latest 20 successful main-push CI runs: it prefers the exact base,
otherwise checks one newest successful candidate's ancestry against that base.
A missing artifact, nonancestor, failure, cancellation or API failure is a cache
miss, not a failed mutation gate. No blind latest artifact or PR promotion is
accepted. The entire producing CI run must be completed successfully.

Pinned official `actions/download-artifact` downloads the selected immutable
artifact ID from that repository/run with digest mismatch set to `error`.
Transport failure falls back to native full execution. The envelope's commit and
key must match, and its native report must pass the independent score audit.
Only ordinary main pushes upload an audited baseline; official
`actions/upload-artifact` publishes one unzipped JSON file. No custom archive
parser or artifact authentication client is maintained.

### Optional own-PR cache (lower trust)

Normal `pull_request` merge-ref runs may also use official `actions/cache` for
`.cache/mutation/pr-baseline.json`. Its exact key binds repository/PR identity
and the same declared-input fingerprint, **not the commit SHA**: a later docs-only
update in that same PR can reuse completed results. No restore-prefix keys are
used. Admission requires a successful restore with an exact cache hit, matching
`prIdentity` and input key, and the existing report audit. The ordinary suite and
native discovery/coverage still run; changed declared inputs still run full.

This is an **own-PR optimization, not authenticated producer provenance**.
`prIdentity`/`audit.execution.baselinePR` name its scope; they are not a producing
commit or a successful whole-CI attestation. A selected main artifact's SHA is
never presented as the producer of a PR-cache report. Saving occurs only after
mutation and encoder checks, not after all sibling CI jobs. Main and release
runs never read this file; forced-full mode bypasses both result sources.
`pull_request_target`, dispatches and non-merge refs cannot save or consume it.

Restore/save failures, eviction, partial/corrupt files or incompatible reports
fall back to full execution. Native caches are immutable: an unusable exact-key
entry cannot be repaired in place and may remain cold until eviction or a
reviewed key-namespace change. No cache failure skips tests or weakens the gate.
See GitHub's [cache-scope restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).

The new envelope is not compatible with the old schema3 cache. The first hosted
native baseline requires successful validation; old reports are not silently
relabeled. Once available, compatible ancestor results can bridge a still-running
exact-main baseline. A changed declared input still requires a cold run.

## Bounded native parallelism

The parser uses two native Stryker test runners, while each Vitest runner keeps
one worker. `timeoutMS` additional allowance (`2000ms`), parser scope and acceptance rules
are unchanged. GitHub documents four CPUs and 16GB RAM for the public
[`ubuntu-24.04` runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
The mutation composite logs `os.availableParallelism()` and total memory so the
actual hosted allocation is observable rather than assumed. Two is also an
explicit local bound; Stryker's automatic CPU-based default is not used.

The worker budget is a measured native configuration choice, not a custom scheduler
or a guarantee that more workers are faster. Worker-budget changes are reviewed against the previous
report for elapsed time, raw timeouts, RuntimeErrors and mutant outcomes—not
merely whether the adjusted score is green. Contention can
change timeout behavior; revert the setting if the measured tradeoff is worse.
See the [native concurrency option](https://stryker-mutator.io/docs/stryker-js/configuration/#concurrency-number--string).

Mutation runs also use Vitest's supported
[`BaseSequencer` extension](https://vitest.dev/config/sequence.html#sequence-sequencer)
to try files with shorter native
[cached durations](https://vitest.dev/api/advanced/vitest.html#cache-gettestspecificationresult)
first. Stryker can stop after a killing test, so this may avoid expensive tests
that cannot change an already detected result. The sorter retains every selected
test specification and inherited native sharding; unknown durations sort last.
It adds no profiler or timing store, changes no ordinary-test configuration, and
makes no whole-parser speedup claim. Survivors still require all selected tests.

## Verification and limits

`npm run test:mutation-cache` checks declared inputs, admission and accounting.
`npm run test:mutation-cache:integration` is a short real Stryker/Vitest toy:
unchanged/docs reuse, forced-full parity and source/helper/fixture/config/lock
invalidation. Weakening the helper or fixture must expose an actual survivor.
The existing required cache-regression check name is retained, but the former
large custom-framework campaign is removed with that framework.

On the local Node 24.22.1 executor, the nine-case native toy completed in 21.4s:
unchanged/docs runs reused all 5 results (0 fresh), while changed-input and forced
runs executed all 5. A bounded native-only replay of an existing completed 809
report took **68.747s, 809 reused / 0 fresh**, with identical mutant identities and
outcomes and 100% adjusted score. Its parser context is main `03c02771`; the
retained cold report was produced locally from `0ec887b55` with those same parser,
test/resource/config/lock bytes and runtime/environment. This diagnostic replay
did not execute the rejected cache prototype or create a production baseline.
The source key took 39.6–45.1ms across five captures (228 included files).

These are local measurements, not a hosted parser latency guarantee. The native
replay overlaps a brief ordinary format/lint check and excludes wrapper/setup
cost, so it is not a controlled end-to-end PR comparison.
Fresh parser campaigns can still take about an hour. Report hosted warm latency
only after a genuine compatible PR completes with an authenticated native main
baseline; npm's package cache hit is not mutation-result reuse.

Primary contracts: [Stryker incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/),
[pinned native differ](https://github.com/stryker-mutator/stryker-js/blob/959127763e5bbe2eb65f5341a8161780d6d8a476/packages/core/src/mutants/incremental-differ.ts),
[official artifact download](https://github.com/actions/download-artifact),
[official raw-file upload](https://github.com/actions/upload-artifact#upload-an-individual-file-unzipped).
