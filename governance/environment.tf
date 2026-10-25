locals {
  release_approver = {
    login = "choskeli"
    id    = 98036866
  }
}

# Publication waits here for one explicit approval from the release approver,
# after the exact tagged commit is tested and its artifacts are verified and
# attested. Administrators cannot skip the approval, and the approver may
# approve a release they started.
resource "github_repository_environment" "release" {
  repository          = github_repository.analyzer.name
  environment         = "release"
  prevent_self_review = false
  can_admins_bypass   = false

  reviewers {
    users = [local.release_approver.id]
  }

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

# Only release tags may deploy to it; branches, including main, cannot.
resource "github_repository_environment_deployment_policy" "release_tags" {
  repository  = github_repository.analyzer.name
  environment = github_repository_environment.release.environment
  tag_pattern = "v*"
}
