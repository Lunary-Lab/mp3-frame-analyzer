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

1. Authenticate complete old and current source snapshots against their full
   file inventories. Schema 3 stores prior transitive helper sources; current
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
   instruction document. Other `.github` paths remain global. Declaration files and `docs/mutation-review.md` stay global.
   The two release-smoke process modules may change independently too, but the
   wrapper/auditor's entire static import closure always stays global, including
   a normally mutable file if it becomes a runtime dependency. All other tooling
   remains global. Parser additions/removals/renames and existing file-mode
   changes still force full execution; new eligible files require mode 0644.
4. Compute selected test closures in **both authenticated old and current**
   sources, including helpers, re-exports, cycles and literal module imports.
   Inspect newly selected tests even when they were absent from the old report.
   Unknown resolution, nonliteral/indirect loading, opaque execution and
   shared-state writers force full. Baseline-selected roots are retained in this
   analysis even if skipped/unreported or removed from the current inventory. Unselected nonparser tests still execute in
   the mandatory normal suite, but are not mutation-test execution roots.
5. Mark changed or import-affected tests as affected. A filesystem-reading closure
   is **never a reusable killing witness**, even on unchanged inputs. Resource
   paths may be computed, external or generated; fresh normal tests alone do not
   prove that an old mutant remains killed. Changed reader tests force full;
   other reader-dependent witnesses rerun while independent pure kills may remain.
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
  check. Fixtures, proof review, workflows, lockfile and unknown paths stay global.
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
runs full. Artifact availability is evaluated once at restore time: a baseline
finishing later does not retroactively seed the running campaign. No wait,
restart, older-ancestor fallback or provenance relaxation is added here.

Schema 3 and explicit plugin isolation intentionally require a **one-time cold
bootstrap**. Schema 2 artifacts are not silently upgraded: a successful new main
run must establish the authenticated dependency/isolation evidence first. Actual
hosted transport must be verified after that first main run.

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
