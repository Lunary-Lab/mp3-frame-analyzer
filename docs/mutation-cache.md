# Native mutation runner and validated incremental results

## Execution policy

`npm run mutation` covers **all `src/mp3/**/*.ts`**, requires **100% adjusted
detection**, and preserves the raw report and source-bound equivalence proofs.
Pinned Stryker/core/Vitest-runner **10.1.1** uses **Vitest 5.0.5**, per-test coverage,
and the explicit parser-test selection in `vitest.mutation.config.ts`.

- **Normal PR:** rerun changed/impacted mutants and their relevant tests; reuse
  only validated unaffected kills from a compatible authenticated main ancestor baseline.
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

1. Authenticate complete old and current source snapshots against their full
   file inventories. Schema 4 stores prior transitive helper and CI workflow sources; current
   bytes are never substituted for missing old dependency evidence.
2. Recognize the bounded **data-only** Stryker/Vitest configuration without
   executing it. Only the pinned Vitest runner plugin is loaded, with isolated
   fork test files, persistent module caching disabled, and a literal parser-test
   selection (explicit paths, `tests/**/*.test.ts`, or the bounded mirrored
   `tests/mp3/**/*.test.ts` glob). Config imports other than the reviewed base spread/re-export,
   setup/globalSetup, plugins, transforms, custom resolvers/loaders, alternate
   config roots, nested packages/tsconfigs and external tsconfig inheritance are
   unsupported and force full execution. The pinned installed transformer and
   package bytes remain global inputs. A bounded root `tsconfig.json` is mandatory;
   absence must not inherit an external parent config.
3. Allow content and path changes to unrelated `src/**/*.ts`, `tests/**/*.ts`,
   `docs/**/*.md` and named root documents (`README`, `AGENTS`, `GLOSSARY`,
   `CHANGELOG`, `CLAUDE`, `TODO`) and the exact `.github/copilot-instructions.md`
   instruction document. Declaration files and `docs/mutation-review.md` stay global.
   The two release-smoke process modules, tooling test files, and explicitly named
   SAST inputs may change independently. CI workflow comparison retains every
   top-level field and the complete mutation job plus transitive prerequisite
   jobs; unrelated job edits do not invalidate kills. Unsupported YAML or job
   dependencies fail closed. Setup actions, acquisition/restore/encoder-gate
   production scripts and unknown tooling remain global. The wrapper/auditor's
   entire static import closure always stays global, including a normally
   mutable file if it becomes a runtime dependency. Parser additions/removals/renames and existing file-mode
   changes still force full execution; new eligible files require mode 0644.
4. Compute selected test closures in **both authenticated old and current**
   sources, including helpers, re-exports, cycles and literal module imports.
   Inspect newly selected tests even when they were absent from the old report.
   Unknown resolution, nonliteral/indirect loading, opaque execution and
   shared-state writers force full. Baseline-selected roots are retained in this
   analysis even if skipped/unreported or removed from the current inventory. Unselected nonparser tests still execute in
   the mandatory normal suite, but are not mutation-test execution roots.
5. Mark changed or import-affected tests as affected. Arbitrary filesystem readers
   remain affected even on unchanged inputs. Six reviewed fixture-reading test
   roots have a narrower contract in `mutation-resource-inputs.mjs`: the **entire
   selected test's transitive source closure** must match its committed SHA-256,
   and every enumerated resource must be present as a mode-0644 regular file in
   both authenticated inventories. The caller, parser, helpers, callback and
   encoding code are bound, not only a filename or read expression. Fixture
   bytes/modes remain global and are also included in each reader's impact set.
   Missing resources, edited/renamed code, unreviewed closures and external sample
   readers never acquire this exemption. No baseline or runtime observation can
   refresh a reviewed digest. Changed arbitrary reader tests force full; other
   reader-dependent witnesses rerun while independent validated kills may remain.
6. Retain only an **unchanged mutant source file's `Killed` result** with an
   unaffected prior killing witness. Witnesses bind source text, file, exact test
   name and location, not unstable IDs. Always rerun equivalents, static mutants
   and timeouts; freshly discover and audit the complete current population and
   source-bound equivalence context at the unchanged 100% adjusted gate.

### Reviewed execution shapes, not a JavaScript purity claim

Nonliteral computed property extraction is unsupported unless its runtime key is
syntactically numeric or it is one of the exact reviewed data-index sites in
`mutation-reviewed-data-access.mjs`. Each exception binds path, **whole source
SHA-256**, and individual AST site. It waives only that element-access check;
imports, nested nodes, readers, reflective/destructuring access and privileged
Vitest assertion-state APIs still undergo every other check. Thirteen current
parser/fixture/test modules have these narrowly reviewed numeric-index sites.
Reflective Object APIs and JSON callback/alias access are unsupported, as are
native TestContext assertion extraction and legacy getter/setter introspection.
Moving or editing an indexed module invalidates its exception and forces full
until independently reviewed; TypeScript annotations are not runtime permission.
No capture, baseline or runner automatically updates these source hashes.

External imports also have a bounded binding contract, not a module-wide
"harmless" designation: only the reviewed Vitest/fast-check named APIs and
`createHash`, `Readable`, and promise `setImmediate` builtin bindings qualify.
Namespace/default/unknown imports and exports fall back full. In particular,
`crypto.setEngine` is a native loader, not a hash function. The property suite
uses the same fast-check functions through named imports; no assertions change.

`mutation-runtime-witness.mjs` similarly binds the complete reviewed executable
wrapper/auditor closure. A successful full run of unfamiliar runtime code cannot
self-authorize later reuse. The runtime validator and witness are the explicit
trusted implementation root; their own bytes remain globally fingerprinted.
The wrapper resolves only the two literal pinned tool package locations and does
not expose an aliased `createRequire` loader.

The mixed encoder test was mechanically separated: all parser checks remain in
native-selected `encoder-layouts.test.ts`; HTTP checks retain their names and
assertions in ordinary `encoder-layouts-http.test.ts`. No mutant is excluded and
all HTTP tests still run every invocation. This removes the opaque Fastify graph
from parser-witness selection rather than pretending it is a pure dependency.

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

- **Every project file**, including untracked files, docs, helpers, fixtures,
  snapshots, generators and configuration. This full forensic inventory is not
  the cross-run compatibility key. The guarded classes above can differ between
  runs, but remain present in before/after evidence and the final immutability
  check. Fixtures, proof review, the mutation execution workflow envelope, lockfile
  and unknown paths stay global.
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

- The PR base SHA (previous SHA for a main push) is the event anchor. Exact-anchor
  successful runs are tried first, including another same-SHA run if an artifact
  is unavailable. Bounded older successful main runs may then be considered.
- Authenticated GitHub comparisons prove **candidate ≤ anchor ≤ tested
  `GITHUB_SHA`**. Timestamps, branch labels and shallow local history are not
  ancestry evidence. A force-push with a nonancestor previous SHA falls back cold.
- A **completed successful main `push`** run of `.github/workflows/ci.yml`, including
  success of the whole producing workflow—not just its mutation job.
- Matching repository IDs, main branch, workflow/source/run/artifact identities,
  unexpired bounded artifact size, and a matching **SHA-256 archive digest**.
- Exactly `manifest.json` and `report.json` in the ZIP. Only those fixed entries
  are read; no archive-provided path is extracted or executed.
- A completed manifest naming that source commit and matching the report digest.
  Before installation, the actual cache validator checks schema, input/policy
  compatibility, baseline sources, full inventory, successful audit and at least
  one eligible killing witness. Incompatible candidates are skipped, not accepted
  merely because they are ancestors. The observed successful run attempt is
  rechecked before provenance is installed; the wrapper independently captures
  and validates current inputs again before execution.

Baseline provenance records `observedRunAttempt`, not an artifact-producing job
attempt: GitHub's [artifact metadata](https://docs.github.com/en/rest/actions/artifacts)
does not identify the latter. A successful rerun of failed jobs can retain a valid
earlier-attempt baseline artifact. Its exact artifact ID, digest, run, source and
compatibility still bind admission; no producing attempt is inferred. This is
distinct from the explicitly same-attempt regression-campaign aggregate below.

Missing/expired artifacts, permission failures, corrupt data or any mismatch
produce a safe miss, never an exception solely because a cache is unavailable.
The search is bounded to eight trusted candidate runs, four downloads, 32 API
requests and 32 MiB per archive. A cumulative 60-second transport budget supplies
remaining-time deadlines to API/native archive calls and is checked between
phases. Synchronous input capture/validation cannot be preempted by this budget;
it may exceed the window before the next safe-miss check. The additional current
snapshot is captured once for all candidates, not once per download.

No wait for running CI, PR-baseline promotion, blind latest-artifact lookup or
provenance relaxation is used. If a suitable artifact is absent at restore time,
the current campaign runs cold. The restore step takes the same workspace lock
as mutation execution and never clears another invocation's state. Native unzip
receives only PATH and a fixed locale, not inherited archive-option variables.

Schema 4 requires a **one-time cold bootstrap** after this implementation lands.
Schema 2/3 artifacts are not silently upgraded; a successful schema-4 main run
must establish the authenticated source/resource/workflow evidence first.

Only successful main-push mutation jobs promote and publish the two validated JSON files;
PR invocations do not promote a local reusable baseline. Consumers additionally
require the entire run's final success. Artifact actions
are pinned to full SHAs; only the mutation job needs `actions: read`. The reusable
release caller grants that read-permission ceiling but **always forces full**.
No PR cache authorizes privileged release publication. Local caches are local
trust, not imported artifact authorization; do not copy arbitrary third-party caches.

## Lifecycle and evidence

- `npm run mutation`: native execution with validated selective reuse if available.
- `npm run mutation:full`: forced full execution.
- `npm run test:mutation-cache`: fast invalidation, isolation, impact and provenance tests.
- `npm run test:mutation-cache:integration`: real Stryker/Vitest scenarios.

Only `.cache/mutation/validated/{manifest,report}.json` is reusable. The disposable
`.cache/mutation/working.json` is recreated every invocation; interrupted Stryker
reports never become validated state. Publication is last, after clean process
exits, full audit, witness accounting and input recheck, with atomic manifest-last
writes. Missing/corrupt/wrong-version/incomplete state safely misses.

Fresh evidence lives in `reports/mutation/`: raw report, execution log, before/after
inputs and `audit.json.execution` with executed/reused/total, mode, reason/code,
changed global field/path diagnostics (never environment values),
affected tests, changed files, baseline commit, elapsed time and input hash.
Failed runs preserve diagnostics but no passing current audit. A directory lock
prevents concurrent invocations sharing state; after an uncatchable kill, confirm
no process remains before manually removing `.cache/mutation/run.lock`.

## Complete cache regression campaign

The default integration command still runs all 70 native Stryker/Vitest cases.
CI executes four independent groups (24 invalidation, 16 impact, 24 compatibility,
6 document scenarios) with `fail-fast: false`. Each leg retains its expected
rejections and successful reports. The stable **Mutation cache regression
(complete campaign)** job requires matrix success and exactly one complete
summary for every group from the same repository, checked-out commit, run and
attempt. Missing, duplicate, incomplete, skipped/cancelled or wrong-outcome
scenarios cannot pass. `All checks` depends on the matrix and its aggregate;
existing required-check names and repository settings do not change.

Artifacts are attempt-qualified and immutable. Rerunning only failed jobs cannot
borrow successful group artifacts from an earlier attempt: rerun the entire
campaign. Four setups and a small aggregate increase runner overhead in exchange
for less wall-clock serialization. Historical 70-case scenario durations totalled
13m08s, with a largest proposed group of 4m29s before setup/queue/aggregate time;
these are a scheduling projection, **not a measured new PR speedup**.

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

The known immutable-fixture reader penalty and exact-base availability race are
fixable project policies, not inherent Stryker limitations. The residual boundary
is complete dependency discovery for arbitrary JavaScript/external state.
Vitest 5.0.5 has maintained
[`experimental.recordDependencies`](https://vitest.dev/config/experimental#experimental-recorddependencies)
for executed per-test-file module imports, including dynamic imports. It explicitly
excludes arbitrary filesystem reads and externalized-module imports. Its internal
dependency cache is not authenticated content evidence, and an unmutated dry-run
graph can miss imports reached only by an active mutant. It may inform a later
resolver redesign, but cannot alone replace the resource/provenance/opaque-code
checks here. Alternatives are explicit reviewed immutable resource contracts,
refactoring fixture loads into tracked data modules, or fresh execution; unknown
behavior is not declared pure to obtain a cache hit.

The installed release contains the Vitest 5 nested-test-name separator and cold
shared-Vite-cache startup fixes. Pinned versions and our regressions reduce risk;
they do not promise a bug-free mutation framework or universally correct caching.
Measurements and full-vs-incremental identities/outcomes are retained with the PR;
read the exact revision/environment rather than extrapolating earlier timings.
