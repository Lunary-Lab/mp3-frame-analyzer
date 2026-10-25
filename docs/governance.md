# Repository governance as code

[`governance/`](../governance/) manages this repository's GitHub settings with Terraform. It adopts the settings that already existed, which read back exactly as before ([adoption record](#adoption-record)), and it holds the main-branch and release-tag rulesets ready for when the organization's plan allows them.

## Status

| Control                                            | State                                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Repository, merge, Actions and Dependabot settings | **Applied**: imported into Terraform state on 2026-10-25; every setting reads back as before                                            |
| Required pull request, checks, no force push       | **Blocked by plan**: written as the `main` ruleset, disabled; GitHub returns 403                                                        |
| Release tags cannot move or be deleted             | **Blocked by plan**: written as the `release-tags` ruleset, disabled                                                                    |
| One owner approval before publication              | **Blocked by plan**: environment required reviewers need Enterprise Cloud; [proposal](#release-approval)                                |
| Build provenance attestations                      | **Blocked by plan**: private repositories need Enterprise Cloud                                                                         |
| GitHub release attestations                        | **Active and verified** for v1.1.0, v1.2.0, v2.0.0 and v2.0.1                                                                           |
| Signed commits on `main`                           | **Not enforced**: every commit on `main` verifies, but pull request branches carry unsigned commits; `require_signed_commits` stays off |

**Nothing prevents a merge today.** The `main` ruleset exists only as code. Until the plan supports it, the [merge-policy audit](releasing.md#merge-policy-audit) reports departures after they happen.

## Plan limits

The organization is on GitHub Free and the repository is private. These responses were read on 2026-10-25 with an organization owner's token, so they are plan limits, not missing permissions:

| Endpoint                              | Response                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Repository rulesets, rules for `main` | 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." |
| Branch protection for `main`          | 403, same message                                                                  |
| Organization rulesets                 | 403 "Upgrade to GitHub Team to enable this feature."                               |

Other security features are unavailable for different reasons:

| Feature                         | Response                                                                          | Reason                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Code scanning default setup     | 403 "Advanced Security must be enabled for this repository to use code scanning." | Needs GitHub Code Security, a paid add-on for private repositories                                  |
| Secret scanning alerts          | 404 "Secret scanning is disabled on this repository."                             | Needs GitHub Secret Protection, a paid add-on for private repositories; CI runs Betterleaks instead |
| Private vulnerability reporting | 404                                                                               | Offered for public repositories only                                                                |

GitHub's documentation sets out what each plan unlocks:

| Capability on a private repository            | Free | Team | Enterprise Cloud | Source                                                                                                                                         |
| --------------------------------------------- | ---- | ---- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Rulesets, branch protection                   | No   | Yes  | Yes              | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)  |
| Environments, deployment branch and tag rules | No   | Yes  | Yes              | [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)                |
| Environment required reviewers                | No   | No   | Yes              | [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)                |
| Artifact (build provenance) attestations      | No   | No   | Yes              | [Using artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) |
| Immutable releases and release attestations   | Yes  | Yes  | Yes              | [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)                               |

The repository stays private, and no plan was changed.

## Tooling

| Component                                                                                   | Version | Why                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Terraform](https://developer.hashicorp.com/terraform)                                      | 1.16.7  | The most widely used infrastructure-as-code tool. Latest patch of 1.16; 1.17.0 was released four days earlier and is not adopted yet. Pinned in [`governance/mise.toml`](../governance/mise.toml) and CI. |
| [`integrations/github`](https://registry.terraform.io/providers/integrations/github/6.13.0) | 6.13.0  | Latest release (2026-07-08). Supports `sha_pinning_required`, rulesets with app-bound status checks, and environments.                                                                                    |

[`.terraform.lock.hcl`](../governance/.terraform.lock.hcl) records the provider's checksums for Linux, macOS and Windows; CI installs it with `-lockfile=readonly`. The Terraform archive CI downloads is checked against a SHA-256 taken from `terraform_1.16.7_SHA256SUMS`, whose signature by HashiCorp's key `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F` was verified when it was pinned.

The provider has no resources for immutable releases, fork pull-request workflow settings on private repositories, or artifact and log retention. Those stay unmanaged.

## What is managed

Every adopted resource is imported, so Terraform never creates or replaces the repository.

| Resource                                        | Adopted properties                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `github_repository.analyzer`                    | Visibility (private), features, forking (off), squash-only merging with PR-title/blank-body commits, branch deletion |
| `github_branch_default.analyzer`                | `main`                                                                                                               |
| `github_actions_repository_permissions`         | Selected actions only: GitHub-owned, verified creators, two listed patterns; full-SHA pinning required               |
| `github_workflow_repository_permissions`        | Read-only default `GITHUB_TOKEN`; Actions may create PRs (Release Please needs it)                                   |
| `github_actions_repository_access_level`        | No other repository may use these workflows                                                                          |
| `github_repository_vulnerability_alerts`        | On                                                                                                                   |
| `github_repository_dependabot_security_updates` | On                                                                                                                   |

Description, homepage, topics, Pages, and template settings are deliberately unmanaged (`ignore_changes`). Collaborators, organization secrets and organization policies are outside this configuration.

The repository cannot be deleted through this configuration:

- While its resource block exists, `prevent_destroy` makes Terraform refuse any plan that would destroy it.
- Deleting the block would remove that guard and plan a destroy, which `archive_on_destroy` turns into archiving. [Stop managing](#stop-managing-the-repository) it with `removed` blocks instead.
- The token used so far has no `delete_repo` scope.

## State

The state lives on the operator's machine at `~/.local/state/mp3-frame-analyzer-governance/terraform.tfstate`: the directory is mode 700 and the file 600. The local backend locks the file during operations.

- It holds repository settings only. No secret is managed, so the state holds no secret value.
- Terraform does not encrypt state. It is encrypted at rest only if the disk is. An encrypted remote backend, such as HCP Terraform or object storage with server-side encryption, needs a new account or credential and is not configured.
- Losing it is recoverable. The import blocks rebuild it from GitHub (see [Recovery](#recovery)).

Never commit state or saved plans. `.gitignore` excludes `*.tfstate*`, `*.tfplan` and `.terraform/`.

## Procedures

Run these from the repository root. Terraform reads `GITHUB_TOKEN`.

The adoption used the existing `gh` login token, a classic token with the `repo`, `workflow`, `read:org` and `gist` scopes. It has no `delete_repo` or `admin:org` scope, but `repo` gives an organization owner full control of every repository in the organization.

A fine-grained token limited to this repository, with Administration read and write, covers every managed resource and is the better long-term credential. Creating one is the owner's decision.

```bash
export GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)"
state_dir="$HOME/.local/state/mp3-frame-analyzer-governance"
install -d -m 700 "$state_dir"
```

**Bootstrap or import.** Install the pinned tools and initialize the backend:

```bash
(cd governance && mise install)
terraform -chdir=governance init -backend-config="path=$state_dir/terraform.tfstate"
```

The first plan imports every resource and updates the two provider-local fields described in the [adoption record](#adoption-record). Review it: no adopted setting may change. Then apply it and restrict the state file:

```bash
terraform -chdir=governance plan
terraform -chdir=governance apply
chmod 600 "$state_dir"/terraform.tfstate*
```

**Change a setting.** Edit `governance/*.tf`, run `terraform -chdir=governance test`, review `plan`, and `apply` only through a reviewed pull request.

**Detect drift.** Exit code 0 means no drift, 2 means GitHub differs from the configuration, and 1 means an error:

```bash
terraform -chdir=governance plan -detailed-exitcode
```

Scheduled drift detection in Actions would need a new credential that can read repository administration settings; `GITHUB_TOKEN` cannot. Run the command above before each settings change and after any change made in the GitHub UI.

Capture a fresh snapshot for comparison. The filter ignores the capture time and treats an empty homepage as `null`, as GitHub displays both the same way. The `releases` and `tags` entries change with every release, so differences there are expected:

```bash
governance/snapshot.sh > /tmp/settings.json
normalize='del(.captured_at) | .settings.repository.value.homepage |= (. // "")'
diff <(jq -S "$normalize" /tmp/settings-before.json) <(jq -S "$normalize" /tmp/settings.json)
```

The snapshot records only names for secrets and variables. Endpoints that are unavailable are recorded with their status and message, never as empty. It exits non-zero if it cannot read the repository. Listing organization secrets needs `admin:org`: the default `gh` credential has it, while the narrower token records those entries as unreadable.

### Recovery

- **State lost or corrupted:** preserve any recoverable state backup before rebuilding it with `init`, `plan` and a reviewed `apply`. With the current `enable_rulesets = false` configuration, `imports.tf` re-adopts the seven existing resources; the plan shows 7 imports and the two provider-local updates. If rulesets have since been enabled, add imports for their existing GitHub IDs as well before applying: the seven committed import blocks do not cover rulesets, and an unreviewed recovery plan could otherwise create duplicates.
  - Applying rewrites an empty homepage from `null` to `""`.
  - Where exact parity matters, restore it with `jq -n '{homepage: null}' | gh api -X PATCH repos/Lunary-Lab/mp3-frame-analyzer --input -`.
- **A setting changed by mistake in the UI:** `plan` shows the difference, and `apply` restores the reviewed value.
- **A bad apply:** revert the change in a pull request, then `apply`.

### Stop managing the repository

In one reviewed pull request, replace each managed resource block with a `removed` block that keeps the real object. Remove its matching block from `governance/imports.tf` and update or remove every remaining reference to it, including disabled ruleset resources and test overrides. A retained import targeting a removed resource makes `plan` fail with "Configuration for import target does not exist" even though `validate` passes.

Review the resulting plan before applying: it must only forget the intended state entries, with no remote creates, changes or destroys. For example:

```hcl
removed {
  from = github_repository.analyzer

  lifecycle {
    destroy = false
  }
}
```

Cover every managed address reported by `terraform -chdir=governance state list`, including any enabled rulesets. The example above is only one resource, not a complete handoff configuration.

The alternative `terraform state rm` procedure also requires removing the corresponding resource and import configuration in a reviewed change. Pause Terraform runs during that handoff: running the old configuration after forgetting state can re-import resources or plan to recreate them. Do not run a blanket state-removal command before preparing the matching configuration change. Never run `terraform destroy`, and never simply delete a resource block while it is still managed in state.

**Turning the rulesets off again** is different: set `enable_rulesets = false` and apply. That deletes the two rulesets on GitHub and nothing else.

### Adoption record

On 2026-10-25 the first plan showed `7 to import, 0 to add, 2 to change, 0 to destroy`.

- **What the two changes were:** provider-local fields the GitHub API never returns: `archive_on_destroy`, the deprecated `ignore_vulnerability_alerts_during_read`, and the repository name of the access-level resource. Applying them re-sent the same values for every configured setting.
- **What the apply changed on GitHub:** a fresh snapshot differed from the pre-adoption one in exactly one field. The provider rewrote the empty homepage from `null` to `""`, which is equivalent.
- **Restored:** `homepage` was reset to `null`. The next snapshot was identical to the pre-adoption snapshot, and the next plan reported "No changes".

The adoption therefore did not run from a zero-change plan. It ran from a plan whose only changes were provider-local, and it changed one GitHub value, the homepage, which was then restored. Any future update of the repository resource writes `""` again. GitHub displays no homepage either way, and the snapshot comparison above treats the two as equal.

## Main branch rules (proposed)

The `main` ruleset in [`rulesets.tf`](../governance/rulesets.tf) is ready for when the plan allows rulesets:

- **No routine approving review.** The pull request rule requires a pull request but 0 approvals, because this repository has one maintainer, who cannot approve their own pull request. Resolved conversations are required; stale approvals are dismissed.
- **Checks.** `All checks` and `Conventional Commit PR title` must pass, both from the GitHub Actions app (ID 15368, observed on this repository's check runs), against a branch that is up to date with `main`.
- **History.** Force pushes and deletion are blocked, and history must be linear. Squash is the only merge method. Signed commits are required only when `require_signed_commits` is set.
- **No merge queue,** because one maintainer gains nothing from one.
- **No bypass actors.** Neither administrators nor automation can skip the rules.

Signed commits stay optional for now:

- GitHub signs every squash merge, and Release Please's branch commits verify.
- The branch commits of #44 to #47 are unsigned.
- GitHub notes that unsigned commits on a head branch can block a squash merge.

Enable `require_signed_commits` once every contributor signs their commits, and verify it by merging a maintainer, Release Please and Dependabot pull request.

The `release-tags` ruleset lets Release Please create `v*` tags and blocks updating or deleting them.

**The required-check contract** in [`checks.tf`](../governance/checks.tf) parses the workflows at plan time. GitHub counts a skipped check as passing, so planning fails if any required check could be missing or skipped on a pull request:

- it is not a job that reports under its own name; matrix and reusable-workflow jobs report derived names;
- it can be skipped, through a condition other than `always()` or through `needs` without `always()`;
- its workflow does not run on `pull_request` or `pull_request_target`;
- its workflow filters by paths or branches, or lists `types` without `opened`, `synchronize` and `reopened`;
- the aggregate is not required or not unique, does not run with `always()`, or does not need every other job in its workflow.

The contract inspects the aggregate's `if` and `needs`. Its step in `ci.yml` fails on any child result other than success, including cancelled and skipped. Each rule has a fixture that must be rejected, and deleting any one rule makes `terraform test` fail. Renaming a check fails the `Governance` workflow on that pull request. That workflow is not a required check, so it warns rather than blocks.

**Release PRs depend on dispatch.** Release Please opens its PRs with `GITHUB_TOKEN`, which starts no workflow runs of its own. Both required checks reach a release PR only through the `workflow_dispatch` calls in `release-please.yml`, which run when Release Please creates or updates the PR. If a strict up-to-date rule leaves the release PR behind `main` without Release Please changing it, use the **Update branch** button. That human push runs the ordinary checks ([recovery](releasing.md#recover-from-a-failed-release)).

**Enable the rulesets** after the organization moves to a plan with private-repository rulesets:

1. Confirm both checks passed on a current pull request: `gh api repos/Lunary-Lab/mp3-frame-analyzer/commits/<head-sha>/check-runs --jq '.check_runs[] | [.name, .conclusion, .app.id] | @tsv'`.
2. Plan and apply with the variable set: `terraform -chdir=governance apply -var enable_rulesets=true`.
3. Make `enable_rulesets` default to `true` in a pull request.
4. Verify that the rules are enforced:
   - read back `gh api repos/Lunary-Lab/mp3-frame-analyzer/rulesets`;
   - open a draft pull request with a failing test, and confirm GitHub refuses to merge it;
   - confirm a green pull request merges without a review, including a Release Please and a Dependabot pull request;
   - confirm that force-pushing and deleting a scratch branch covered by a temporary copy of the ruleset are rejected. Never test this against `main`.

**In an emergency,** such as a broken required check that blocks a fix, an organization owner changes the ruleset's enforcement to `disabled` in the UI, merges the fix through a pull request, and runs `terraform apply`, which restores it. GitHub's audit log records the change; link that entry from an issue describing the emergency.

## Release approval

Final publication should wait for exactly one approval from the repository owner. That is taken to be `choskeli` (user ID 98036866), the account authenticated for this work. Release Please and other automation must not count as that approval.

**A native gate is not available.** A `release` environment with `choskeli` as its only reviewer would be the native gate, configured with:

- `prevent_self_review = false`, so the owner can approve a release they started;
- `can_admins_bypass = false`;
- deployment limited to `v*` tags.

Required reviewers on a private repository need Enterprise Cloud. On Free, private repositories have no environments at all. No workflow-level substitute has been built.

**Today's only human step is merging the release PR.** CI then validates the exact tag and publishes automatically. The merge comes before the artifacts are built, so it does not approve specific bytes, and nothing stops another administrator from merging.

### Proposal: an owner-signed release tag (awaiting approval)

The owner's SSH-signed annotated tag becomes the single approval. The signing key stays on the owner's machine.

1. On pushes to `main`, Release Please runs with `skip-github-release: true`, so it only manages the release PR. After the release PR is merged, its `autorelease: pending` label stops Release Please from opening another release PR until the release exists.
2. A read-only workflow validates the merged release commit and uploads the tested archive, SBOM, manifest and `SHA256SUMS` as a run artifact.
3. The owner reviews that run, then signs a tag locally. Its message binds the version, the commit (the tag target), the validation run ID, and the SHA-256 of `SHA256SUMS`:

   ```bash
   git tag -s vX.Y.Z <commit> -m "vX.Y.Z" -m "Validation-Run: <run-id>" -m "SHA256SUMS: <digest>"
   git push origin vX.Y.Z
   ```

4. The tag push starts publication, which publishes only if all of these hold:
   - the tag is annotated and its signature verifies against a committed `allowed_signers` file that names only the owner's key;
   - the tagged commit is the merged release PR's commit, and the version matches the manifest;
   - the named run succeeded on that commit;
   - its artifact hashes to the signed digest.

   Release Please then creates the draft on the existing tag, which updates its label. The workflow attaches the tested bytes without rebuilding them and publishes. GitHub's release attestation then signs the tag, commit and asset digests.

**Properties:**

- New artifacts, a different run, or a different commit no longer match the signed tag, so an old approval cannot authorize them.
- A wrong signer or an edited tag would fail verification. On 2026-10-25, `git verify-tag` with an `allowed_signers` file naming only the owner's key was tried on scratch tags:
  - accepted the owner-signed tag ("Good "git" signature … SHA256:okSW5tlz…");
  - rejected a tag signed by another key under the same tagger email (exit 1, "No principal matched.");
  - rejected the owner's tag with one edited digest (exit 1, "Signature verification failed: incorrect signature").
- Anyone can check the approval independently of CI with `git verify-tag` and the committed signer file.

This is a workflow-level gate, not a native one. An administrator who can edit workflows could publish without it. The signature still lets every consumer detect a release the owner did not sign. Source review of Release Please 17.6.0 found that it resolves annotated tags to their commit, and that the pending-label lock closes the window between merge and tag. Building this changes `release-please.yml` and `publish-release.yml`, so it needs the owner's approval and coordination with the CI changes.

## Signing and release authenticity

**Commits.**

- Squash merges on `main` are signed by GitHub.
- The maintainer signs local commits with an SSH key registered on GitHub as a signing key.
- All 45 commits on `main` verified on 2026-10-25, but pull request branch commits from other tools are unsigned.

Nothing enforces signatures yet. `require_signed_commits` would, once rulesets are available and every contributor signs. The merge-policy audit does not check signatures; adding that detective check to `scripts/main-policy-audit-checks.mjs` is a follow-up.

**Tags.** The published `v1.1.0`, `v1.2.0`, `v2.0.0` and `v2.0.1` tags are lightweight tags created by Release Please on GitHub-signed commits. They are locked by immutable releases and are not recreated. Signed annotated tags for future releases are part of the [proposal](#proposal-an-owner-signed-release-tag-awaiting-approval).

**Release attestations.** Immutable releases are on. GitHub signs a release attestation binding the tag, commit and asset digests:

- Signer: certificate SAN `https://dotcom.releases.github.com`, issued by GitHub's Fulcio intermediate.
- Timestamp: `timestamp.githubapp.com`.

Verify a release or a downloaded asset:

```bash
gh release verify v2.0.0 --repo Lunary-Lab/mp3-frame-analyzer
gh release verify-asset v2.0.0 mp3-frame-analyzer-2.0.0.tar.gz --repo Lunary-Lab/mp3-frame-analyzer
```

On 2026-10-25:

- All four releases verified, and the genuine 2.0.0 and 2.0.1 archives verified against their own tags.
- The archive with one appended byte was rejected (exit 1, "attestation for v2.0.0 does not contain subject sha256:1c8d…").
- The genuine 2.0.0 archive checked against `v1.2.0` was rejected (exit 1).

`gh release verify` always checks against GitHub's release signer identity, and that identity cannot be overridden. Wrong-signer rejection is therefore demonstrated for the proposed signed tag instead.

**Build provenance.** Release attestations prove what GitHub published, not which workflow built it. Build provenance (`actions/attest`) needs Enterprise Cloud for a private repository. That job stays skipped, and no release may be described as build-attested.

Two other approaches are rejected:

- **Public Sigstore signing** would publish the private repository's name, workflow and commits to a public transparency log. It is not used without the owner's approval.
- **A CI-held signing key** would be readable by every workflow, because Free has no environment secrets.

The owner-signed tag above is the private-compatible alternative. It binds the owner's approval to the exact artifact digest, but it does not replace platform-attested build provenance.

## Pending owner decisions

Nothing below was built, bought, created or changed:

1. **Release approval:** approve or decline the [owner-signed release tag](#proposal-an-owner-signed-release-tag-awaiting-approval).
2. **Approver:** confirm `choskeli` as the only release approver.
3. **Plan:**
   - GitHub Team enables both rulesets, and environments with branch and tag rules.
   - Enterprise Cloud also enables environment required reviewers and private build provenance.
4. **Credentials:**
   - A fine-grained token limited to this repository for Terraform.
   - Any credential for scheduled drift detection in Actions.
5. **State:** keep the local state, which is not encrypted, or adopt an encrypted remote backend that needs a new account or credential.
6. **Signed commits:** enable `require_signed_commits` once every contributor signs.

## Observations for the owner

- Actions may create and approve pull requests because Release Please opens its PR with `GITHUB_TOKEN`. With no approval required on `main`, an Actions approval grants nothing.

## Sources

- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Signing tags](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-tags)
- Provider documentation for [`github_repository_ruleset`](https://registry.terraform.io/providers/integrations/github/6.13.0/docs/resources/repository_ruleset) and [`github_repository_environment`](https://registry.terraform.io/providers/integrations/github/6.13.0/docs/resources/repository_environment)
- [Release Please 17.6.0 source](https://github.com/googleapis/release-please/tree/v17.6.0): tag creation in `src/github-api.ts`, label flow in `src/manifest.ts`
