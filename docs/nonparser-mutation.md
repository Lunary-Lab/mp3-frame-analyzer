# Pure runtime mutation stage

`npm run mutation:pure` uses the maintained Stryker 10.1.1 Vitest runner against
exactly three nonparser modules:

| Module                  | Verified fresh mutants killed |
| ----------------------- | ----------------------------: |
| `src/client-error.ts`   |                         3 / 3 |
| `src/error-response.ts` |                     163 / 163 |
| `src/server-config.ts`  |                       49 / 49 |
| **Total**               |                 **215 / 215** |

The local Node 24.22.1 / Vitest 5.0.5 verification on 2026-10-27 took 21 seconds,
ran 101 native tests, and had zero survivors, timeouts, uncovered mutants, runtime
errors, ignored mutants or reused results. This is a measured small campaign, not
a whole-repository score or a timing guarantee. No mutation operators are ignored
and the native breaking threshold remains 100%. A direct JSON assertion also
requires the exact nonempty three-source inventory and every mutant to be `Killed`: native
scoring excludes some error statuses and treats timeouts as detected. Missing or
malformed reports and any other status fail; there are no equivalence exemptions.

The visible **Pure runtime mutation (100%)** CI job runs independently with the
existing locked-project setup. It is required by `All checks`, keeps its own JSON
report under `reports/mutation-pure/`, and sends TERM after 115 seconds
with a process-group KILL five seconds later. It uses read-only repository access.
The command first clears only its own `reports/mutation-pure/` output; its temporary
workspace is the independent `.stryker-pure-tmp/`. Neither directory is nested under
the parser campaign's output or temporary directory. The parser campaign, parser
proof policy and native parser cache remain separate.

## Why fresh and small

This campaign uses native per-test coverage, two mutation workers and mirrored
unit-test filenames. The source inventory in `scripts/nonparser-pure-scope.mjs`
requires a deliberate active/deferred assignment for new nonparser modules.

The measured campaign is inexpensive enough to run freshly. A direct incremental
experiment on this pinned Stryker version retained 61 stale static survivors after
new tests; the fresh verification killed all 61. That was a stale failure report,
not a false pass. This stage therefore has no mutation-result reuse or custom cache
engine. Dependency installation still uses the existing project setup/cache.

## What the tests establish

Tests assert sanitized response/status/connection-close behavior, framework-code
precedence, exact multipart protocol classifications, non-Error rejection, deliberate
error identity, and strict deployment-limit parsing. Error inputs construct inside
tests, so a broken constructor is observed as a test failure rather than an import
failure. The mapper uses native noncoercing Map lookup and integer validation;
redundant type-only checks were simplified without removing invalid-input rejection.

Upload, admission, multipart budgets, asynchronous lifecycle, logging/bootstrap,
and release/cache-policy mutation expansion remain separate stages. Their ordinary
coverage and integration tests still run; they are **not** claimed as mutation-enforced
by this gate. No live Terraform settings or required-check names change.
