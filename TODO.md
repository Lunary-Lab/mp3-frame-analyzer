# Follow-up engineering tasks

## Remove TypeScript 6 compatibility alias (target review: 2026-12-15)

- [ ] **Review on or before December 15, 2026**. This is an engineering
      reassessment date, **not a guaranteed release date**.
- [ ] Check whether **stable** TypeScript 7.1 (or later) exposes the compiler API
      required by the installed `typescript-eslint`, with officially supported
      peer dependencies.
- [ ] Verify that type-aware ESLint, builds, and tests all pass when the
      TypeScript 6 compatibility alias is removed, without `--force` or
      `--legacy-peer-deps`.
- [ ] Replace `typescript: npm:@typescript/typescript6@6.0.2` and
      `@typescript/native: npm:typescript@7.0.2` with a single normal
      `typescript` dependency; remove `typecheck:legacy`; regenerate lockfile.
- [ ] Re-run `npm ci`, formatting, ESLint, TypeScript, tests, mutation,
      security scanning, and CI. **Do not remove the alias if tooling is still
      incompatible, regardless of date.**

**Status (checked 2026-10-24):** still required. Stable `typescript` is 7.0.2
and 7.1 is in beta; `typescript-eslint@8.72.0` still declares the peer range
`typescript >=4.8.4 <6.1.0`. Upstream tracking:
[typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).

**Automatic trigger:** `scripts/temporary-dependencies.test.mjs` fails as soon
as a dependency update changes that peer range, so the Dependabot PR that could
make the alias obsolete cannot pass CI until this item is reassessed.

**Official references:**

- [Microsoft — TypeScript 7 side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)
- [Microsoft — TypeScript 7.1 Beta, Oct 20 2026](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
- [TypeScript 7.1 iteration plan and provisional release milestones](https://github.com/microsoft/TypeScript/issues/63703)
- [typescript-eslint compiler support](https://typescript-eslint.io/users/dependency-versions/)

## Quality follow-ups

- [x] Expand mutation testing to every runtime parser module and enforce 100%
      adjusted detection with exact, reviewed equivalence exceptions. Raw
      counts, proof assumptions and execution scope are recorded in
      [the mutation review](docs/mutation-review.md).
- [ ] Reassess surviving mutants after parser/tooling changes; retain defensive
      checks and do not suppress mutants for cosmetic improvements.
- [x] Extract shared ID3 traversal and header-error classification to make
      the counting loop easier to follow and remove its complexity warning.
- [x] **Owner decision:** default HTTP counts exclude one recognized initial
      Xing/Info/VBRI metadata frame (6089 for the sample); explicit
      `includeVbrHeaderFrame=true` returns 6090 physical frames. This is a
      breaking API contract change. Current evaluator clarification, evidence,
      and the compatibility plan are in
      [the frame-count contract](docs/frame-count-contract.md).

## Repository settings and supported format

Verified on 2026-10-24; details in [release setup](docs/releasing.md).

- [x] Squash merges only, PR title as the commit subject, blank commit body,
      merge and rebase merges disabled, merged branches deleted.
- [x] GitHub Actions may create release PRs (Release Please opened PR #10 with
      `GITHUB_TOKEN`); default token permissions stay read-only.
- [x] Allowed Actions limited to GitHub-owned actions plus
      `googleapis/release-please-action` and
      `amannn/action-semantic-pull-request`; SHA pinning is required.
- [x] Dependabot alerts and security updates enabled.
- [x] Immutable releases enabled; published releases reject added assets.
- [x] Full release lifecycle exercised: release PR → tag → validated,
      published, independently smoke-tested assets (1.1.0 through 2.1.0).
- [x] Rulesets enforce a pull request, both required checks
      (`All checks` and the Conventional Commit PR title), an up-to-date
      branch, resolved conversations, linear history and protected
      release tags, with no bypass (`governance/`).
- [x] Build provenance attestations run for every release, and publication
      waits for the release approver in the `release` environment.
- [ ] Remove the scoped `typed-rest-client` / `qs` override (review by
      2026-12-15). `@stryker-mutator/core@10.1.1` (latest, 2026-10-23) still
      requires `typed-rest-client ~2.3.0`, whose 2.3.1 pins `qs@6.15.1`
      ([GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26),
      [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g),
      [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)).
      Fixed `typed-rest-client` 3.x is not yet adopted upstream:
      [stryker-js#6177](https://github.com/stryker-mutator/stryker-js/pull/6177).
      **Remove when** the locked `typed-rest-client` no longer pins a vulnerable
      `qs`; `scripts/temporary-dependencies.test.mjs` fails on that dependency
      update. Then delete the override, regenerate the lockfile, and rerun
      mutation testing and both audits.
- [x] Implement bounded free-format MPEG-1 Layer III frame-spacing inference and independent tests. Ambiguous very short streams are rejected.

## Mutation validation follow-up

- [x] Expand mutation testing to every parser module, including the stateful reader, traversal, and error class.
- [x] Review every survivor after the parser updates from PRs #8, #13 and #16: 46 killed with new tests, 28 documented equivalents (raw 95.97%, adjusted 100%).
- [ ] Preserve the raw score alongside the 100% audited gate; never suppress mutants solely to improve a headline metric.
