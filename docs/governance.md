# Repository governance as code

[`governance/`](../governance/) manages this repository's GitHub settings with Terraform: merge rules, Actions policy, security features, the `main` and release-tag rulesets, and the `release` environment that gates publication.

## Status

| Control                                                                      | State                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Squash-only merging, read-only workflow token, SHA-pinned selected actions   | Enforced                                                               |
| `main`: pull request, `All checks` and PR-title checks, up-to-date branch    | Enforced by the `main` ruleset; no bypass                              |
| `main`: resolved conversations, linear history, no force push                | Enforced by the `main` ruleset; no bypass                              |
| Release tags cannot move or be deleted                                       | Enforced by the `release-tags` ruleset and immutable releases          |
| One approval from the release approver before publication                    | Enforced by the `release` environment; administrators cannot bypass it |
| Build provenance, release attestations, secret scanning with push protection | On                                                                     |

[Verification](#verification) records how each was tested against GitHub.

## What is managed

| Resource                                        | Settings                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `github_repository.analyzer`                    | Public; squash-only merging with PR-title/blank-body commits; branch deletion; secret scanning and push protection |
| `github_branch_default.analyzer`                | `main`                                                                                                             |
| `github_actions_repository_permissions`         | Selected actions only: GitHub-owned, verified creators, two listed patterns; full-SHA pinning required             |
| `github_workflow_repository_permissions`        | Read-only default `GITHUB_TOKEN`; Actions may create PRs (Release Please needs it)                                 |
| `github_repository_vulnerability_alerts`        | On                                                                                                                 |
| `github_repository_dependabot_security_updates` | On                                                                                                                 |
| `github_repository_ruleset.main`                | See [Main branch rules](#main-branch-rules)                                                                        |
| `github_repository_ruleset.release_tags`        | `v*` tags may be created but never updated or deleted                                                              |
| `github_repository_environment.release`         | See [Release approval](#release-approval)                                                                          |

Description, homepage, topics, Pages and template settings are deliberately unmanaged (`ignore_changes`). Organization policies are outside this configuration.

The provider has no resources for these settings, which were set once through the REST API and are recorded in the [snapshot](../governance/snapshots/baseline.json):

| Setting                         | Value                                           |
| ------------------------------- | ----------------------------------------------- |
| Immutable releases              | On                                              |
| Fork pull request workflows     | Require approval for every external contributor |
| Private vulnerability reporting | On                                              |
| Code scanning                   | CodeQL default setup                            |

The repository cannot be deleted through this configuration:

- While its resource block exists, `prevent_destroy` makes Terraform refuse any plan that would destroy it.
- Deleting the block would remove that guard and plan a destroy, which `archive_on_destroy` turns into archiving. [Stop managing](#stop-managing-the-repository) it with `removed` blocks instead.
- The documented token has no `delete_repo` scope.

## Tooling

| Component                                                                                   | Version | Why                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Terraform](https://developer.hashicorp.com/terraform)                                      | 1.16.7  | The most widely used infrastructure-as-code tool. Latest patch of 1.16; 1.17.0 had been out four days when this was pinned. Pinned in [`governance/mise.toml`](../governance/mise.toml) and CI. |
| [`integrations/github`](https://registry.terraform.io/providers/integrations/github/6.13.0) | 6.13.0  | Latest release (2026-07-08). Supports `sha_pinning_required`, rulesets with app-bound status checks, and environments.                                                                          |

[`.terraform.lock.hcl`](../governance/.terraform.lock.hcl) records the provider's checksums for Linux, macOS and Windows; CI installs it with `-lockfile=readonly`. The Terraform archive CI downloads is checked against a SHA-256 taken from `terraform_1.16.7_SHA256SUMS`, whose signature by HashiCorp's key `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F` was verified when it was pinned.

## State

The state lives on the operator's machine at `~/.local/state/mp3-frame-analyzer-governance/terraform.tfstate`: the directory is mode 700 and the file 600. The local backend locks the file during operations.

- It holds repository settings only. No secret is managed, so the state holds no secret value.
- Terraform does not encrypt state. It is encrypted at rest only if the disk is.
- Losing it is recoverable. The import blocks rebuild it from GitHub (see [Recovery](#recovery)).

Never commit state or saved plans. `.gitignore` excludes `*.tfstate*`, `*.tfplan` and `.terraform/`.

## Procedures

Run these from the repository root. Terraform reads `GITHUB_TOKEN`; use a token with admin rights on this repository and no `delete_repo` scope:

```bash
export GITHUB_TOKEN="$(env -u GH_TOKEN gh auth token)"
state_dir="$HOME/.local/state/mp3-frame-analyzer-governance"
install -d -m 700 "$state_dir"
(cd governance && mise install)
terraform -chdir=governance init -backend-config="path=$state_dir/terraform.tfstate"
```

**Change a setting.** Edit `governance/*.tf` in a pull request and run `terraform -chdir=governance test`. After the pull request merges, run `plan`, review it, `apply`, then `chmod 600 "$state_dir"/terraform.tfstate*`.

**Change visibility first.** The provider sends visibility and the secret scanning settings in one request, and GitHub refuses secret scanning on a private repository. To make a private copy public, run `gh api -X PATCH repos/Lunary-Lab/mp3-frame-analyzer -f visibility=public` before `apply`. The Actions access-level setting applies only to private repositories, so it is not managed here.

**Detect drift.** Exit code 0 means no drift, 2 means GitHub differs from the configuration, and 1 means an error:

```bash
terraform -chdir=governance plan -detailed-exitcode
```

Run it before each settings change and after any change made in the GitHub UI.

**Compare with the snapshot.** [`snapshot.sh`](../governance/snapshot.sh) records repository-level settings as JSON, with names only for secrets and variables. It records unavailable endpoints with their status and message, never as empty, and exits non-zero if it cannot read the repository:

```bash
governance/snapshot.sh > /tmp/settings.json
normalize='del(.captured_at) | .settings.repository.value.homepage |= (. // "")'
diff <(jq -S "$normalize" governance/snapshots/baseline.json) <(jq -S "$normalize" /tmp/settings.json)
```

The filter treats an empty homepage as `null`, as GitHub displays both the same way.

### Recovery

- **State lost or corrupted:** delete it and run `init`, `plan` and `apply` again. The import blocks re-adopt the seven imported resources. A fresh import also plans provider-local fields that GitHub never returns, such as `archive_on_destroy`; the rulesets and environment must be imported by ID (`terraform import 'github_repository_ruleset.main[0]' mp3-frame-analyzer:<id>`, `terraform import github_repository_environment.release mp3-frame-analyzer:release`) before `apply`, or it would try to create duplicates.
- **A setting changed by mistake in the UI:** `plan` shows the difference, and `apply` restores the reviewed value.
- **A bad apply:** revert the change in a pull request, then `apply`. [`baseline.json`](../governance/snapshots/baseline.json) records the reviewed values.

### Stop managing the repository

In a pull request, replace each resource block with a `removed` block that keeps the real object, then `apply`. Terraform forgets the resources and leaves GitHub untouched:

```hcl
removed {
  from = github_repository.analyzer

  lifecycle {
    destroy = false
  }
}
```

Write one block for each address in `terraform -chdir=governance state list`. Equivalently, run `terraform -chdir=governance state rm $(terraform -chdir=governance state list)` and then delete `governance/` in a pull request. Never run `terraform destroy`, and never delete a resource block without a `removed` block.

### Emergency changes

Neither administrators nor automation can bypass the rulesets. If a broken required check blocks an urgent fix, an organization owner applies `-var enable_rulesets=false`, merges the fix through a pull request, and applies again without the variable, which restores both rulesets. GitHub's audit log records both changes; link them from an issue describing the emergency.

## Main branch rules

The `main` ruleset in [`rulesets.tf`](../governance/rulesets.tf):

- **No routine approving review.** A pull request is required but needs 0 approvals: this repository has one maintainer, who cannot approve their own pull request. Conversations must be resolved; stale approvals are dismissed.
- **Checks.** `All checks` and `Conventional Commit PR title` must pass, both from the GitHub Actions app (ID 15368), against a branch that is up to date with `main`.
- **History.** Force pushes and deletion are blocked and history must be linear. Squash is the only merge method.
- **No merge queue,** because one maintainer gains nothing from one.
- **No bypass actors.**
- GitHub's default "additional approval for unattributed Copilot pull requests" stays on; the provider cannot manage it, and it has no effect while 0 approvals are required.

**Signed commits are not required.** An automated contributor opens pull requests with commits it cannot sign, and GitHub notes that unsigned commits on a pull request branch can block its squash merge. Commits still reach `main` only as squash merges, which GitHub signs itself, so `main` stays verified in practice; nothing rejects an unsigned commit. To require signatures again once every contributor can sign, change the `require_signed_commits` default to `true` in a pull request.

**The required-check contract** in [`checks.tf`](../governance/checks.tf) parses the workflows at plan time. GitHub counts a skipped check as passing, so planning fails if any required check could be missing or skipped on a pull request:

- it is not a job that reports under its own name; matrix and reusable-workflow jobs report derived names;
- it can be skipped, through a condition other than `always()` or through `needs` without `always()`;
- its workflow does not run on `pull_request` or `pull_request_target`;
- its workflow filters by paths or branches, or lists `types` without `opened`, `synchronize` and `reopened`;
- the aggregate is not required or not unique, does not run with `always()`, or does not need every other job in its workflow.

The contract inspects the aggregate's `if` and `needs`. Its step in `ci.yml` fails on any child result other than success, including cancelled and skipped. Each rule has a fixture that must be rejected, and deleting any one rule makes `terraform test` fail. Renaming a check fails the `Governance` workflow on that pull request.

**Release PRs depend on dispatch.** Release Please opens its PRs with `GITHUB_TOKEN`, which starts no workflow runs of its own. Both required checks reach a release PR through the `workflow_dispatch` calls in `release-please.yml`, which run when Release Please creates or updates the PR. If the strict up-to-date rule leaves the release PR behind `main` without Release Please changing it, use the **Update branch** button; that human push runs the ordinary checks ([recovery](releasing.md#recover-from-a-failed-release)).

## Release approval

Final publication waits for exactly one approval from the release approver, `choskeli` (user ID 98036866). The `release` environment in [`environment.tf`](../governance/environment.tf):

- lists `choskeli` as its only required reviewer;
- sets `prevent_self_review = false`, so the approver can approve a release they started;
- sets `can_admins_bypass = false`, so administrators cannot skip the approval;
- admits only `v*` tags, so no branch, including `main`, can deploy to it.

Only the `publish` job of [`publish-release.yml`](../.github/workflows/publish-release.yml) uses it. By the time it asks for approval, the same run has validated the exact tagged commit with the full reusable CI, tested the unpacked artifact, and attested the tested bytes. Approving in **Actions → the run → Review deployments** releases the job, which downloads those bytes, verifies their checksums, attaches them to the draft and publishes it without rebuilding. A new tag, commit or set of artifacts means a new run, which waits for a new approval. Comments, labels, reviews and bot actions do not satisfy it.

## Signing and release authenticity

- **Commits** reach `main` only as squash merges, which GitHub signs. Signatures on pull request branch commits are not required.
- **Release tags** are created by Release Please on GitHub-signed release commits. Immutable releases lock a tag and its assets when the release is published, and the `release-tags` ruleset blocks moving or deleting `v*` tags before then.
- **Release attestations.** For each published release, GitHub signs an attestation binding the tag, commit and asset digests.
- **Build provenance.** The `provenance` job attests the tested artifacts with [`actions/attest`](https://github.com/actions/attest) (SLSA build provenance, recorded in the public Sigstore transparency log), binding each digest to this repository, `publish-release.yml` and the tag.

Verify a release and an asset:

```bash
tag=vX.Y.Z
gh release download "$tag" --repo Lunary-Lab/mp3-frame-analyzer
gh release verify "$tag" --repo Lunary-Lab/mp3-frame-analyzer
gh release verify-asset "$tag" "mp3-frame-analyzer-${tag#v}.tar.gz" --repo Lunary-Lab/mp3-frame-analyzer
gh attestation verify "mp3-frame-analyzer-${tag#v}.tar.gz" --repo Lunary-Lab/mp3-frame-analyzer \
  --signer-workflow Lunary-Lab/mp3-frame-analyzer/.github/workflows/publish-release.yml --source-ref "refs/tags/$tag"
```

A modified asset fails both `verify-asset` and `attestation verify`; an asset from another release fails `verify-asset` for this tag.

## Verification

[`snapshots/baseline.json`](../governance/snapshots/baseline.json) is the settings read back after the configuration was applied on 2026-10-25. Enforcement was tested against GitHub, not inferred from the configuration; the pull request that introduced this document records the evidence.

## Sources

- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- Provider documentation for [`github_repository_ruleset`](https://registry.terraform.io/providers/integrations/github/6.13.0/docs/resources/repository_ruleset) and [`github_repository_environment`](https://registry.terraform.io/providers/integrations/github/6.13.0/docs/resources/repository_environment)
