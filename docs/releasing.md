# Versioning and releases

Releases distribute a versioned runtime archive through GitHub Releases. The npm package remains `private: true`; this workflow never publishes to the npm registry.

## Version authority

[Release Please Action v5](https://github.com/googleapis/release-please-action/blob/v5.0.0/README.md) maintains the release PR, changelog, package version, lockfile version, and `.release-please-manifest.json`. The manifest starts at **1.0.0**, with bootstrap commit `fa85190d2f4ad31453c32e90cff0b76ae432526a`. This is a version baseline, not evidence of a published 1.0.0 artifact. `last-release-sha` pins the 2.0.0 release commit on `main` as the start of the next release notes; later releases are found before it, so it never needs updating. The next nonbreaking `feat` release advances it to **1.1.0**.

Use Conventional Commit PR titles and **squash merge with the PR title as the commit title**. Release Please reads the resulting commits on `main`; PR labels do not provide a second versioning authority. The squash commit body defaults to **blank** because Release Please also parses commit bodies: a `BREAKING CHANGE:` note or a paragraph starting `fix:` copied from branch commits or a PR description would otherwise add releases the title did not declare. Mark breaking changes with `!` in the PR title; a deliberate `BREAKING CHANGE:` footer can still be typed into the merge dialog. Optional scopes describe the changed area without changing the bump. Dependabot uses `fix(deps):` for production dependency updates, `build(deps-dev):` for development-only updates, and `ci(deps):` for Actions updates.

| Squashed PR title                                                     | Effect                   |
| --------------------------------------------------------------------- | ------------------------ |
| `fix(api): correct multipart error classification`                    | Patch                    |
| `perf(parser): reduce header copying`                                 | Patch                    |
| `feat(parser): support appended metadata`                             | Minor                    |
| `feat(api)!: change the frame-counting contract`                      | Major                    |
| `docs: clarify setup`, `ci: update checks`, `chore: maintain tooling` | No release by themselves |

An intentional incompatible change to the JSON shape, documented status semantics, or accepted API contract requires a breaking-change marker. The owner-approved change from a physical-frame HTTP default to excluding one recognized initial Xing/Info/VBRI metadata frame changes that contract and requires a major release. It is structural exclusion, not audio decoding. Use a breaking PR title such as `feat(api)!: exclude initial encoder metadata by default`; let Release Please update the version, changelog, lockfile and release manifest. Correcting an implementation to its documented contract remains a fix.

## Automated path

1. A merge to `main` runs `release-please.yml`. Its metadata-only job creates or updates the release PR; it does not check out project code.
2. The workflow explicitly dispatches **CI and Conventional Commit PR title validation at the release PR head** using `GITHUB_TOKEN`. This avoids relying on token-generated PR events or their approval-dependent runs. GitHub documents `workflow_dispatch` as an allowed trigger for this token in [Triggering a workflow](https://docs.github.com/actions/using-workflows/triggering-a-workflow). The dispatched check runs attach to the release PR's head commit, but GitHub does not list `workflow_dispatch` runs in the PR's checks tab. Review them from the `check-release-pr` job log, which prints both run URLs, or with `gh api repos/Lunary-Lab/mp3-frame-analyzer/commits/<head-sha>/check-runs`. GitHub also queues the token-created PR's ordinary `pull_request` CI as **awaiting approval**. Approving it (Actions → the run → _Approve and run_) adds a second, PR-visible validation of the merge ref; CI is read-only, so approval grants no write access.
3. Review and squash merge the release PR. Release Please creates a **draft release** and, with `force-tag-creation`, creates its `vX.Y.Z` tag while it is still a draft.
4. The workflow dispatches `publish-release.yml` **at that exact tag**, passing its full commit SHA. Preflight requires a matching draft, a matching tag commit already reachable from `main`, and `GITHUB_SHA` equal to the declared source commit. Dispatching from `main` is rejected.
5. The reusable, read-only CI validates that commit. It checks Node 24 and 26, npm compatibility, formatting, lint, both TypeScript compilers, coverage, tooling, mutation testing, fuzzing, dependency audits, static analysis, secrets, and measured memory/HTTP behavior. The Node 24 release lane packages the existing compiled output and tests the unpacked artifact; the publisher never rebuilds it.
6. Optional build-provenance attestation uses the tested asset checksums. Publication downloads those same assets, verifies their checksums, rechecks the draft/tag, attaches the files, and only then publishes the draft. A required validation or enabled attestation failure leaves it unpublished.

The version verifier requires agreement between `package.json`, both lockfile root versions, the release manifest, and the supplied release tag. In CI, the recorded source commit must equal the checked-out Git HEAD. Tag-based invocation also keeps the standard attestation's workflow commit aligned with the actual build source.

## Published files

| File                                     | Contents                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mp3-frame-analyzer-X.Y.Z.tar.gz`        | Compiled JavaScript, package metadata, lockfile, README, runtime instructions, and embedded release metadata |
| `mp3-frame-analyzer-X.Y.Z.cdx.json`      | CycloneDX application SBOM generated by `npm sbom --omit=dev --package-lock-only`                            |
| `mp3-frame-analyzer-X.Y.Z.manifest.json` | Version, tag, source commit, and packaging Node/npm versions                                                 |
| `SHA256SUMS`                             | SHA-256 digests of the three files above                                                                     |

The runtime archive is deliberately assembled from compiled output; `npm pack` is not the release artifact. It does not contain `node_modules`, development sources, tests, or fixtures. Runtime installation uses `npm ci --omit=dev --ignore-scripts`; see [runtime instructions](runtime.md). Checksums detect byte changes but do not independently prove publisher identity or build provenance.

## Permission separation

| Stage             | Elevated permissions and boundary                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Release Please    | `contents`, `issues`, and `pull-requests: write`; pinned automation, no checkout or project execution |
| Dispatch          | `actions: write`; schedules validation/publication using validated metadata                           |
| Publish preflight | `contents: write` to inspect otherwise-hidden drafts; metadata only, no checkout                      |
| Validation        | `contents: read`; project code and dependencies run only in these read-only jobs                      |
| Provenance        | `id-token: write` and `attestations: write`; downloads tested assets, no project checkout/build       |
| Publication       | `contents: write` and `actions: read`; downloads and uploads tested assets, no rebuilding             |

Workflow actions are pinned by commit. Ordinary PR title validation uses `pull_request_target` only to inspect metadata; it never executes PR code. The dispatched title check also verifies that it is checking the current release PR head.

## Repository settings

Values below were read back from the GitHub API after being saved on **2026-10-24**. The repository stays private.

| Setting                                | Value                                                                                                                                           | Status                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Merge methods                          | Squash only; merge commits and rebase merges disabled                                                                                           | Enabled                                                                                             |
| Squash commit                          | Title = PR title (`PR_TITLE`), body = blank (`BLANK`)                                                                                           | Enabled; used for PR #8                                                                             |
| Delete merged branches                 | On                                                                                                                                              | Enabled; verified on PR #8                                                                          |
| Auto-merge                             | Off (nothing would wait for checks)                                                                                                             | Unchanged                                                                                           |
| Default `GITHUB_TOKEN` permissions     | Read-only, at both the organization and the repository                                                                                          | Unchanged                                                                                           |
| Actions may create and approve PRs     | On, at both levels; GitHub offers one combined switch                                                                                           | Verified: Release Please opened PR #10                                                              |
| Allowed Actions                        | GitHub-owned, plus `googleapis/release-please-action@*` and `amannn/action-semantic-pull-request@*`; SHA pinning required (organization policy) | Enabled; previously "all actions"                                                                   |
| Fork PR workflows (private)            | Not run; no write tokens or secrets                                                                                                             | Unchanged                                                                                           |
| Dependabot alerts and security updates | On                                                                                                                                              | Enabled; previously off                                                                             |
| Immutable releases                     | On                                                                                                                                              | Enabled; verified on v1.1.0: adding an asset returns HTTP 422 and `gh release verify v1.1.0` passes |
| Branch protection and rulesets         | Return **403**: "Upgrade to GitHub Pro or make this repository public" (organization rulesets: "Upgrade to GitHub Team")                        | **Blocked by plan**                                                                                 |
| Build provenance attestations          | Private repositories require GitHub Enterprise Cloud; `ENABLE_ARTIFACT_ATTESTATIONS` is unset                                                   | **Blocked by plan**; the provenance job was skipped for v1.1.0                                      |

**Nothing enforces review or required checks.** Passing workflow files do not establish a merge policy. Treat `All checks`, `Conventional Commit PR title`, and an approval from someone other than the author as the merge standard. The [merge-policy audit](#merge-policy-audit) reports departures after they happen. When the plan allows it, add a ruleset for `main` that requires a PR, one approval with stale approvals dismissed, resolved conversations, and both checks; blocks force pushes and deletion; and grants no bypass except a documented emergency role. Add a tag ruleset protecting `v*` from updates and deletion.

**Immutable releases** lock a release's assets and tag once it is published. Drafts remain editable, so publication attaches every asset to the draft first and then publishes it; published versions are never overwritten. GitHub's release attestation for immutable releases is a platform feature separate from build provenance.

**Build attestations** use the first-party [`actions/attest`](https://github.com/actions/attest) action, which GitHub recommends over the `attest-build-provenance` wrapper for new implementations. The job runs automatically for public repositories. For this private repository, it runs only after Enterprise Cloud is available and the Actions variable **`ENABLE_ARTIFACT_ATTESTATIONS=true`** is set. When it is skipped, a validated release still publishes with checksums and an SBOM, and must not be described as build-attested. See [attestation availability](https://github.com/actions/attest-build-provenance#usage) and [the attestation documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations).

## Merge-policy audit

GitHub returns **403** for branch protection and rulesets on this private repository under the organization's Free plan, so no merge rule is enforced. `main-policy-audit.yml` is a **detective** control, not a substitute: after every push to `main`, it reads metadata only and fails if any pushed commit:

- is not a single-parent squash commit, or has a subject that is not a Conventional Commit;
- did not arrive through a merged pull request based on `main`;
- came from a PR head without passing **All checks** and **Conventional Commit PR title** check runs; or
- was force-pushed.

It warns when the PR had no approval from someone other than its author. A failed audit means the policy was bypassed after the fact; investigate it and correct `main` through a new PR. Release publication separately revalidates the exact tagged commit, so an unchecked merge cannot publish without passing CI.

## Local verification

From a clean checkout with Node 24 and the documented npm 11.19.0. Archive packaging uses **GNU tar on Linux**, matching the GitHub runner:

```bash
npm ci --ignore-scripts
npm run check
npm run verify:version
npm run package:release
npm run test:artifact
```

`npm run check` produces `dist/`. Packaging reuses it; the artifact test extracts the archive into an isolated temporary directory, installs only locked runtime dependencies, and checks the compiled application. The full reusable CI adds the security, fuzzing, mutation, and performance gates described above. Release mutation validation always forces full execution and never trusts incremental result caches. Use `npm run mutation:full` for the same local guarantee.

## Release record

| Version                                                                                    | Tag commit                                                                                                   | Publication run                                                                                                | Validation                                        | Provenance     | Immutable                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------- | --------------------------------- |
| [v1.1.0](https://github.com/Lunary-Lab/mp3-frame-analyzer/releases/tag/v1.1.0), 2026-10-24 | `82a59e5e50c1361b7dcd8e5463bfee662a01c4bb` ([#10](https://github.com/Lunary-Lab/mp3-frame-analyzer/pull/10)) | [40115887988](https://github.com/Lunary-Lab/mp3-frame-analyzer/actions/runs/40115887988) at `refs/tags/v1.1.0` | All six reusable CI jobs passed at the tag commit | Skipped (plan) | Yes; release attestation verified |

v1.1.0 was the first full exercise of the lifecycle. Release Please opened release PR #10 with `GITHUB_TOKEN` and dispatched CI and title checks for its head. After the squash merge, it created the draft and lightweight tag and dispatched publication at that tag. Publication validated the tag commit and attached the tested files. SHA-256 digests:

```text
39ea8747daa9635de8cc2e16299db07315ae9ecb556e02a1994331c4a3cda188  mp3-frame-analyzer-1.1.0.tar.gz
4be821cce6b36b4347e7c21f65ede92763fa3e277c5cbd6f7bb8141ed349a485  mp3-frame-analyzer-1.1.0.cdx.json
7dae839d8e0b6850ed003f2062d95b6c5a7f52daff6bb87ce03182644e9668e1  mp3-frame-analyzer-1.1.0.manifest.json
e6f80d97044bcc6c2cfcddfd72f860cf7ca6145202ea94ca514ee4b76d4a7161  SHA256SUMS
```

Independent checks after publication:

- The downloaded files pass `sha256sum --check`, equal GitHub's asset digests, and are byte-identical to the run's tested `release-assets` artifact.
- The manifest's `sourceCommit` equals the tag commit, and the archive contains only the runtime inventory.
- A fresh extract with production-only dependencies returned 6090 for the assessment sample and 33 for `cbr.mp3`. After a rejected 16 MiB upload it still served a pipelined request on the same connection, and it exited 0 on `SIGTERM`.

Those counts describe the published v1.1.0 physical-frame default. The later
owner-approved HTTP default returns 6089 and 32 for those files, respectively;
an explicit `includeVbrHeaderFrame=true` retains physical counting. That source
change does not alter the already published artifact or imply a new release.

The 1.1.0 changelog heading links to the release because the 1.0.0 baseline was never tagged.

## Verify a published release

Download every asset of one release into an empty directory, then check the digests, metadata, and runtime:

```bash
tag=v1.1.0
mkdir "release-$tag" && cd "release-$tag"
gh release download "$tag" --repo Lunary-Lab/mp3-frame-analyzer
sha256sum --check SHA256SUMS
jq . "mp3-frame-analyzer-${tag#v}.manifest.json"   # version, tag, sourceCommit
gh api "repos/Lunary-Lab/mp3-frame-analyzer/commits/$tag" --jq .sha   # must equal sourceCommit
```

Then follow [the runtime guide](runtime.md) to extract the archive, install production dependencies, upload an MP3, and stop the server with `SIGTERM`. When build attestations are enabled, also run `gh attestation verify "mp3-frame-analyzer-${tag#v}.tar.gz" --repo Lunary-Lab/mp3-frame-analyzer` and confirm that the reported workflow is `publish-release.yml` at `refs/tags/$tag`.

## Recover from a failed release

- **Release PR validation failed:** fix the cause in an ordinary PR. Release Please regenerates the release PR, and redispatches its checks, only when its title or notes change. Otherwise use the release PR's **Update branch** button; that human-initiated push runs the ordinary PR checks. Publication revalidates the tagged commit either way.
- **Publication failed after the draft and tag were created:** a retry runs the workflows and source from the tag, so changes merged to `main` cannot repair it. Retry the draft as shown below for transient failures, such as a runner or network error. If the tagged source or its workflows are defective, leave the draft unpublished or delete it, merge the fix, and let Release Please propose the next version. Never move or recreate a release tag.
- **A published release is defective:** published releases are immutable. Merge a correction and release a new version.

## Retry an unpublished draft

Set the existing draft tag and obtain its full 40-character commit SHA, then dispatch from that same tag:

```bash
release_tag=v1.1.0
release_sha="$(gh api "repos/Lunary-Lab/mp3-frame-analyzer/commits/$release_tag" --jq .sha)"
gh workflow run publish-release.yml \
  --repo Lunary-Lab/mp3-frame-analyzer \
  --ref "$release_tag" \
  -f "tag=$release_tag" \
  -f "sha=$release_sha"
```

Replace `v1.1.0` with the actual draft tag. A `--ref main` invocation fails preflight, as does a changed tag, non-`main` source commit, mismatched SHA, or already-published release. Retrying may replace assets only while the release remains a draft. Publication is serialized and checks existing stable versions so retrying an older draft cannot move the `latest` designation backwards. For a published defect, merge a correction and release a new version.
