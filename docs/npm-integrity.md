# npm source and integrity policy

Every existing CI project install runs the zero-dependency
`node scripts/verify-npm-lock.mjs` **before** `npm ci`. This includes the shared
setup action, scheduled dependency audit and extended fuzz workflow. Generated
release-artifact smoke installs invoke the same pure policy on the extracted
manifest/lock before native npm, with the same explicit registry flags. The shared
setup is used by the required CI jobs; a rejected lock stops installation rather
than becoming an advisory or skipped test.

The guard discovers every tracked and non-ignored new `package.json` and
`package-lock.json`, including newly added directories. Each manifest needs its
matching lock. Tracked ignored files remain covered, symlinked inputs/ancestor
paths fail, and `npm-shrinkwrap.json` is rejected because it could override the
reviewed lock. Active shrinkwrap paths are checked even when ignored by Git.

## Supported profile

This repository uses nonempty npm v3 lockfiles and public-registry tarballs.
Every direct, transitive, optional and platform-specific lock entry must contain:

- an exact version and canonical HTTPS `registry.npmjs.org` tarball URL whose
  package name and version agree with that entry;
- one canonical, complete SHA-512 SRI digest, not a missing/weak/abbreviated hash;
- a package path and identity consistent with its declared registry alias.

Root manifest/lock identity and dependency declarations must match, direct
versions must be exact, and every direct dependency must have a matching entry.
Registry aliases are supported, including the existing transitive TypeScript
alias. One alias name cannot mean different source packages in different parts
of the graph under this deliberately narrow profile.

File/workspace/link/git/URL dependency sources, workspace roots, bundled entries,
shrinkwrap (including package-entry `hasShrinkwrap` markers) and legacy lock
formats require separate integrity review and fail
with an actionable error. These are legitimate ecosystem features, not inherently
unsafe formats; their integrity/source semantics are not silently assumed here.
Registry-package workspace metadata (such as ESLint's own publisher layout) is
not treated as a workspace root in this repository.

Nested `overrides` may select exact registry versions using plain package-name
selectors, preserving the current `typed-rest-client`/`qs` override. Alternate
sources, alias/reference overrides and version-qualified selectors require
explicit review. Native offline probes proved that shrinkwrap expansion and
same-version file overrides can install bytes outside the top-level inventory
even when ordinary `npm ci` lock validation passes; this profile rejects both
before installation rather than attempting another resolver.

Native `npm ci --ignore-scripts` remains the dependency resolver and verifier of
the **actual tarball bytes**. It performs its native manifest/lock consistency checks;
the guard does not implement a second npm resolver. Explicit registry and
`--replace-registry-host=never` flags keep ambient registry configuration from
rewriting reviewed tarball sources. A valid hash binds the complete archive,
including its contained files; it does not prove publisher trust, absence of
hidden bundled content, or freedom from vulnerabilities. Existing dependency
scans stay required and their databases remain live.

## Why a small guard rather than another scanner

The maintained `lockfile-lint` 5.1.0 strict-integrity mode correctly rejects missing
or weak SRI. Native probes nevertheless accepted missing `resolved`, wrong
tarball versions, mismatched alias targets and empty lock inventories. Installing
that CLI as a project development dependency would also run its check only
**after** the acquisition it is meant to constrain, adding 43 packages without
the required pre-install guarantee.

This guard uses only native Node JSON, URL and Base64 handling, no npm-private
APIs and no new dependencies or custom graph resolver. Native offline npm tests
demonstrate that a correct digest passes, a substituted digest fails with
`EINTEGRITY`, and missing SRI can otherwise pass npm itself. Separate negative
tests cover source/version/alias consistency, unsupported source forms, new-file
discovery and actual install-block short-circuiting before npm executes.

Run the preflight locally without installing dependencies:

```bash
node scripts/verify-npm-lock.mjs
```

This policy concerns declared checked-in npm inputs, not arbitrary shell code
that creates another package project at runtime. The package manager's own
verified bootstrap is a separate acquisition control.

Primary references:

- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- [npm lockfile format](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)
- [npm registry replacement configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#replace-registry-host)
- [lockfile-lint source](https://github.com/lirantal/lockfile-lint)
