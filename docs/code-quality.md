# Code quality limits

These are this project's review and CI policies, not universal definitions of
good code. They apply to maintained TypeScript and JavaScript: application and
parser code, build/release scripts, mutation/cache gates, fuzz generators,
benchmarks, and configuration modules. Generated output and dependencies remain
outside the lint scope; hand-written tooling does not.

| Check                 | Production limit | Enforcement                                                     |
| --------------------- | ---------------: | --------------------------------------------------------------- |
| Cyclomatic complexity |  10 per function | ESLint error                                                    |
| File size             |   300 code lines | ESLint error; blank/comment-only lines excluded                 |
| Function size         |    60 code lines | ESLint error; blank/comment-only lines excluded; IIFEs included |
| Maximum line width    |   120 characters | ESLint error with narrow exceptions below                       |
| Formatting width      |   100 characters | Existing Prettier configuration, unchanged                      |

Prettier's preferred wrapping width is not a hard maximum. The separate ESLint
width gate rejects lines above 120 even when Prettier cannot wrap them.

Width exceptions are limited to a standalone, single-line quoted/template
literal, or a comment containing only an HTTP(S) URL. They preserve exact binary
protocol strings, generated-source fixtures and useful links. A line merely
containing a string or URL is **not** exempt: surrounding code still has to fit.
One descriptive test-call line has a local, explained width suppression because
Prettier keeps that call together. There are no production complexity or size
suppressions.

## Test policy

Test files (`*.test.ts`, `*.test.js`, `*.test.mjs`, `*.test.cjs`) retain complete
declarative scenario tables and suite callbacks. They do not inherit the
production file/function line caps: splitting a table or nested `describe` only
to reduce its measured length makes the tests harder to review. Width checks
still apply. Test helpers outside test files retain the production size caps.

The existing TypeScript-test complexity warning above 16 is preserved and made
consistent for JavaScript test files. This advisory threshold is deliberately
separate from the production error at 10; it is not permission to hide production
logic in test files. Test behavior, assertions and coverage/mutation thresholds
must not be weakened to satisfy a metric.

## Refactoring and exceptions

Prefer cohesive responsibilities with explicit inputs and outputs. Do not split
arbitrary predicates, rename production files as tests, compress statements onto
one line, change the complexity variant, or add blanket parser/tooling exemptions
to silence a limit. Preserve validation order, typed failures, returned values,
iterator/resource lifecycles, cache trust boundaries and artifact contents.

Before a behavior-preserving refactor, establish characterization cases on the
original implementation; compare the candidate's results and failures where
practical. Keep every existing assertion. Coverage, differential tests and
mutation checks provide bounded evidence, not proof that no possible behavior
has changed. Any source-bound mutation equivalence needs independent context and
location review, even if only helper placement changes.

An exceptional production suppression must be local, state the invariant or
unavoidable external contract, explain why an ordinary decomposition is worse,
and include focused tests plus reviewer approval. Exceptions should be rare;
none are needed by this refactor.

`scripts/complexity-policy.test.mjs` checks effective file scopes, error severity,
10/11 complexity, 300/301 file lines, 60/61 function lines, IIFEs, comment/blank
handling, 120/121 width, and the limited test/literal exceptions. `npm run check`
includes those tests through `test:tooling`; `npm run lint` fails on every
production limit because the rules are errors, not warnings.

The pinned ESLint 10 release still provides the core `max-len` rule. It is
deprecated upstream, so an ESLint major-version upgrade must migrate that rule
to its maintained replacement and rerun the policy boundary tests. This change
does not add an otherwise unnecessary plugin dependency to the current lockfile.

References: [complexity](https://eslint.org/docs/latest/rules/complexity),
[max-lines](https://eslint.org/docs/latest/rules/max-lines),
[max-lines-per-function](https://eslint.org/docs/latest/rules/max-lines-per-function),
[max-len](https://eslint.org/docs/latest/rules/max-len),
[Prettier print width](https://prettier.io/docs/options#print-width).
