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

- [x] Classify and test the 16 surviving Stryker mutants; the latest local score is
      98.27%, with only 3 equivalent survivors and a 95% CI minimum.
- [ ] Reassess surviving mutants after parser/tooling changes; retain defensive
      checks and do not suppress mutants for cosmetic improvements.
- [x] Extract shared ID3 traversal and header-error classification to make
      the counting loop easier to follow and remove its complexity warning.
- [ ] **Owner decision:** confirm whether `frameCount` includes the Xing/Info
      metadata frame (6090 for the sample) or counts audio frames only (6089,
      matching MediaInfo and FFprobe). Evidence, the clarification question, and
      the change/versioning plan are in
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
- [x] Immutable releases enabled; v1.1.0 rejects added assets (HTTP 422) and
      passes `gh release verify`.
- [x] Full release lifecycle exercised: release PR #10 → tag `v1.1.0` at
      `82a59e5` → validated, published, independently smoke-tested assets.
- [ ] **Blocked by plan:** require `All checks`, `Conventional Commit PR title`,
      an independent approval, and protected release tags. Branch protection
      and rulesets return 403 for this private repository on the organization's
      Free plan (Team or higher, or a public repository, is required).
      `main-policy-audit.yml` detects bypasses after the fact; it does not
      prevent them.
- [ ] **Blocked by plan:** build provenance attestations for this private
      repository require GitHub Enterprise Cloud. When available, set the
      Actions variable `ENABLE_ARTIFACT_ATTESTATIONS=true` and verify a release
      with `gh attestation verify`.
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
