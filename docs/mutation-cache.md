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
narrow `--mutate` or preserve an old inventory in place of current discovery.
`npm run mutation:full`, scheduled CI, full manual CI and exact-source release
validation force full execution.

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
(except `docs/mutation-review.md`), governance files, Semgrep configuration and
fixtures, the Copilot instructions, and the parent `ci.yml`. The latter's exact
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

The new envelope is not compatible with the old schema3 cache. The first hosted
native baseline requires successful validation; old reports are not silently
relabeled. Once available, compatible ancestor results can bridge a still-running
exact-main baseline. A changed declared input still requires a cold run.

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
