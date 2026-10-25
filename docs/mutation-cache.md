# Native mutation runner and validated incremental results

## Execution policy

`npm run mutation` covers **all `src/mp3/**/*.ts`**, requires **100% adjusted
detection**, and preserves the raw report and source-bound equivalence proofs.
Pinned Stryker/core/Vitest-runner **10.1.1** uses **Vitest 5.0.5**, per-test coverage,
and the explicit parser-test selection in `vitest.mutation.config.ts`.

- **Normal PR:** rerun changed/impacted mutants and their relevant tests; reuse
  only validated unaffected kills from a successful exact-base main baseline.
- **Missing/stale baseline, global input changes, or uncertain impact:** full run.
- **Release, weekly verification, or `npm run mutation:full`:** execute all mutants.

Every invocation runs the **normal full Vitest suite**, then Stryker's fresh
coverage/discovery dry run. Every generated mutant is audited, whether fresh or
reused. A newly generated report does **not** imply every mutant executed anew.
No narrowed mutation scope, `--testFiles` filter, exclusion, or reduced score is
introduced. Native per-test execution also speeds up full runs.

## What can safely be retained

Stryker's [incremental mechanism](https://stryker-mutator.io/docs/stryker-js/incremental/)
tracks source/test changes but does not establish arbitrary cross-module impact.
Our additional boundary deliberately supports this project's static ESM layout:

1. Compare the authenticated old and current input inventories. Only existing
   parser-module and `tests/**/*.test.ts` **content** changes can be selective.
   Added, removed, renamed or mode-changed files force full execution. A changed
   file absent from the baseline's authenticated source report also forces full.
2. Compute each test file's transitive imports in **both old and current** sources,
   including re-exports, cycles and literal dynamic imports. Unresolved/ambiguous
   paths, nonliteral imports, unsupported packages or opaque execution force full.
3. Mark changed test files and files importing changed modules affected. A test
   with filesystem-read capability is **never a reusable killing witness**, even
   on unchanged inputs: the import graph cannot establish its actual read paths,
   and excluded/generated/external bytes could differ. Changed filesystem-read
   tests and known external-state-writing graphs conservatively force full.
4. Retain only an **unchanged mutant source file's `Killed` result** with at least
   one unaffected prior killing-test file. Test witnesses bind source text, file,
   exact test name and location—not unstable numeric IDs. Stryker performs its
   own fresh discovery/mapping too; accounting verifies the resulting witness.
5. Always rerun **equivalents, static mutants and timeouts**. Re-audit the complete
   current parser population and equivalence context, then publish successful state.

Vitest uses isolated fork workers per test file. A real two-file regression
verified module-cache, `globalThis` and `process.env` separation. This does not
isolate shared files, subprocesses, network services or all possible JavaScript
side effects. The supported contract is deterministic tests with tracked inputs,
not a security sandbox or a proof about arbitrary code. The AST capability checks
are conservative safeguards, not universal side-effect analysis. Before adding
opaque/external dependencies, use full mode and extend/review this boundary.

An equivalence-policy **context hash alone** may differ after its normal manual
source/proof review. Changed proof entries, identities, assumptions, target or
version force full. The old report is audited against its own authenticated
policy/source; the current report against the current policy/source. Cache code
never updates equivalence proofs or their context automatically.

## Global invalidation boundary

The SHA-256 manifest binds:

- All other project files, including untracked files, helpers/setup, fixtures,
  snapshots, generators, config/workflows, lockfile and **Markdown/docs**. Markdown
  can be test input; a docs-only change therefore currently falls back to full.
  Known generated/build/runtime directories are excluded.
- Installed dependency bytes, modes and symlink destinations, not just the
  lockfile. Dependency links must remain inside the fingerprinted tree and out of
  runtime caches; unsupported linked installs fail closed. Root Vitest/Vite caches
  are excluded, and persistent transformed-module caching is disabled.
- Node executable/component versions, npm version, OS/kernel/architecture/libc,
  runner-image identity, LAME availability/version/executable, and external
  `ASSESSMENT_SAMPLE_PATH` bytes.
- The entire supported child environment: property seed/path, sample path,
  `NODE_OPTIONS`, locale/timezone, platform/home/temp paths, PATH and CI. Only the
  explicit allowlist reaches test code; credentials/unknown variables do not.
  `PROPERTY_SEED` defaults to `20261024`. `NODE_OPTIONS` always forces full because
  it may load external code. Environment values are hashed, not published.

The complete input fingerprint is rechecked after execution. Concurrent changes
fail without promotion. Host/toolchain identity changes have deterministic unit
coverage; this does not claim native Windows/macOS/alternate-Node runtime testing.
No finite matrix establishes every possible host or external-service behavior.

## Trusted GitHub baseline transport

PR result caches must not authorize later gates. We therefore use immutable
[workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data),
not broad `actions/cache` restore keys or PR-scoped result caches.

`restore-mutation-baseline.mjs` queries GitHub's read-only API and requires:

- The exact PR base SHA (previous SHA for a main push), in the same repository.
- A **completed successful main `push`** run of `.github/workflows/ci.yml`, including
  success of the whole producing workflow—not just its mutation job.
- Matching repository IDs, main branch, workflow/source/run/artifact identities,
  unexpired bounded artifact size, and a matching **SHA-256 archive digest**.
- Exactly `manifest.json` and `report.json` in the ZIP. Only those fixed entries
  are read; no archive-provided path is extracted or executed.
- A completed manifest naming that source commit and matching the report digest;
  the wrapper then independently validates schema, input/policy compatibility,
  baseline source hashes, full inventory and successful audit.

Missing/expired artifacts, API permission failures, corrupt data or any mismatch
clear restored state and fall back to full. There is no fallback to an older or
PR-produced baseline. The first rollout necessarily runs full until successful
main artifacts exist; a PR whose exact base has no finished successful CI also
runs full. Actual hosted transport must be verified after that first main run.

Only successful main-push mutation jobs publish the two validated JSON files;
consumers additionally require the entire run's final success. Artifact actions
are pinned to full SHAs; only the mutation job needs `actions: read`. The reusable
release caller grants that read-permission ceiling but **always forces full**.
No PR cache authorizes privileged release publication. Local caches are local
trust, not imported artifact authorization; do not copy arbitrary third-party caches.

## Lifecycle and evidence

- `npm run mutation`: native execution with validated selective reuse if available.
- `npm run mutation:full`: forced full execution.
- `npm run test:mutation-cache`: fast invalidation, impact and provenance tests.
- `npm run test:mutation-cache:integration`: real Stryker/Vitest scenarios.

Only `.cache/mutation/validated/{manifest,report}.json` is reusable. The disposable
`.cache/mutation/working.json` is recreated every invocation; interrupted Stryker
reports never become validated state. Publication is last, after clean process
exits, full audit, witness accounting and input recheck, with atomic manifest-last
writes. Missing/corrupt/wrong-version/incomplete state safely misses.

Fresh evidence lives in `reports/mutation/`: raw report, execution log, before/after
inputs and `audit.json.execution` with executed/reused/total, mode, reason,
affected tests, changed files, baseline commit, elapsed time and input hash.
Failed runs preserve diagnostics but no passing current audit. A directory lock
prevents concurrent invocations sharing state; after an uncatchable kill, confirm
no process remains before manually removing `.cache/mutation/run.lock`.

## Upstream limitations and mitigations

- Stryker 10.1.1's incremental differ omits prior `duration`. Fresh non-timeout
  results may legitimately have **zero** duration; missing duration requires a
  validated unaffected killing witness. Timeouts always rerun and still require
  **positive finite** fresh duration. No timing is fabricated or copied back.
- [Static incremental invalidation](https://github.com/stryker-mutator/stryker-js/issues/6119)
  can retain a stale survivor after adding a killing test. Reproduced on the pinned
  versions; static mutants are never retained here.
- [Static activation with `--testFiles`](https://github.com/stryker-mutator/stryker-js/issues/6144)
  can incorrectly survive. Reproduced; this wrapper rejects that CLI narrowing and
  uses config-level include with fresh full discovery.
- Native-runner `--logLevel debug` can fail during circular config serialization
  on these versions. Keep normal/info logging; this is an upstream diagnostic
  limitation, not a false passing gate. Hook errors may produce runtime errors or
  zero-duration kills; invalid outcomes fail closed and legitimate zero-ms kills
  are covered by an accounting regression.

The installed release contains the Vitest 5 nested-test-name separator and cold
shared-Vite-cache startup fixes. Pinned versions and our regressions reduce risk;
they do not promise a bug-free mutation framework or universally correct caching.
Measurements and full-vs-incremental identities/outcomes are retained with the PR;
read the exact revision/environment rather than extrapolating earlier timings.
