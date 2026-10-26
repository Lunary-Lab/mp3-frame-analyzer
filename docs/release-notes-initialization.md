# Initial release notes after repository migration

A version in the package manifest is not proof that its tag or GitHub Release
exists in this repository. The pinned Release Please implementation can infer a
previous version from that manifest even when no corresponding tag exists. Its
first-release entry can link to its own `releases/tag/vX.Y.Z` page instead of
containing a previous-tag comparison; that header alone is never a baseline.
The notes planner therefore never creates a historical tag or silently guesses
a predecessor after a lookup failure.

For an existing previous tag, ordinary generation retains explicit tag/SHA
boundaries. If the previous version has no tag, the initial-release path requires
an explicitly reviewed `.github/release-notes-initial.json` committed **before**
the release is tagged:

```json
{
  "schemaVersion": 1,
  "repositoryId": "<current numeric repository ID, as a string>",
  "baseSha": "<reviewed 40-character initialization commit>",
  "previousVersionTag": "vX.Y.Z"
}
```

These placeholders are documentation, not runnable configuration. Rediscover the
current repository ID, source ancestry and version before filling them. No
initialization file is generated automatically, and no archive state or old
approval is inherited.

The planner requires:

- the API repository ID and full name to match the current workflow;
- the initialization ID to match that repository;
- the base SHA to equal the tagged Release Please `last-release-sha`;
- a readable version manifest at that exact base matching the previous version;
- the base to be a strict ancestor of the release source, and any bootstrap
  anchor not to truncate that range;
- the current tag to be the repository's only tag, with no other releases;
- complete compare, per-commit PR-association and independent merged-PR coverage.

The metadata-only native API job repeats the repository/tag/release inventory
checks with its write token, which can see drafts. It omits `previous_tag_name`
only in this explicit initial mode: GitHub documents that field as a **tag name**,
not a commit-baseline parameter. It never passes a SHA pretending to be a tag.
The native PR set must exactly equal the independently audited commit range;
missing or extra entries stop preparation. A native comparison to some other
boundary also fails. No API error, absent initialization or incomplete inventory
is converted into a successful empty result.

The composed initial body replaces only the user entry's header link with the
verified immutable SHA comparison and explains the initialization boundary.
Breaking and migration text is unchanged. The manifest records both the original
user-entry hash and final body hash, stable repository ID, source SHA, boundary,
producer run and attempt. Plain historical version headings delimit entries so
older releases are not accidentally copied into the next entry.

After the first actual release, the next entry uses its real previous tag and the
normal path. The initialization file does not override an existing release range.
Changed identities, artifacts or attempts require a new prepared candidate and
the same single owner publication approval; a preview does not approve release.

## Verification status

Offline fixtures exercise both modes, malformed/missing initialization,
repository replacement, tag/history drift, boundary ancestry, PR coverage, and
execution of the fixed native-job script against a local API stub. They are not
a live native `generate-notes` service test. The first live preparation must still
be checked before any publication approval; unknown native formatting fails
closed rather than being guessed.

## Sources

- [Release Please 17.6.0 manifest boundary and inferred-version logic](https://github.com/googleapis/release-please/blob/v17.6.0/src/manifest.ts)
- [Pinned strategy's previous-tag selection](https://github.com/googleapis/release-please/blob/v17.6.0/src/strategies/base.ts)
- [GitHub generate-notes endpoint and permissions](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release)
