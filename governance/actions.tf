# Workflows get a read-only GITHUB_TOKEN unless a job asks for more, and run
# only GitHub-owned, verified-creator, or the two listed third-party actions,
# each pinned to a full commit SHA.
resource "github_actions_repository_permissions" "analyzer" {
  repository           = github_repository.analyzer.name
  enabled              = true
  allowed_actions      = "selected"
  sha_pinning_required = true

  allowed_actions_config {
    github_owned_allowed = true
    verified_allowed     = true
    patterns_allowed = [
      "amannn/action-semantic-pull-request@*",
      "googleapis/release-please-action@*",
    ]
  }
}

# Release Please opens its release PR with GITHUB_TOKEN; GitHub offers one
# switch for creating and approving PRs. Approvals by Actions satisfy nothing:
# main requires no approving review (docs/governance.md).
resource "github_workflow_repository_permissions" "analyzer" {
  repository                       = github_repository.analyzer.name
  default_workflow_permissions     = "read"
  can_approve_pull_request_reviews = true
}
