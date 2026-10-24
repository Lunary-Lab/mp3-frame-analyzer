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

**Official references:**
- [Microsoft — TypeScript 7 side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)
- [Microsoft — TypeScript 7.1 Beta, Oct 20 2026](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
- [TypeScript 7.1 iteration plan and provisional release milestones](https://github.com/microsoft/TypeScript/issues/63703)
- [typescript-eslint compiler support](https://typescript-eslint.io/users/dependency-versions/)

## Quality follow-ups

- [ ] Reassess meaningful surviving Stryker mutants; avoid weakening tests,
  suppressing mutants, or manufacturing score-only assertions.
- [ ] Resolve the parser's advisory complexity warning only if extracting
  smaller functions makes the implementation clearer.
- [ ] If the evaluator specifies whether Xing metadata frames count,
  reconcile the API contract and sample expectations accordingly.
