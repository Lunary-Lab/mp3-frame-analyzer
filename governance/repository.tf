resource "github_repository" "analyzer" {
  name       = local.repository
  visibility = "private"

  has_issues      = true
  has_projects    = true
  has_wiki        = false
  has_discussions = false
  is_template     = false
  allow_forking   = false
  archived        = false

  # Squash only, titled by the Conventional Commit PR title with a blank body:
  # Release Please reads these commits on main (docs/releasing.md).
  allow_squash_merge          = true
  allow_merge_commit          = false
  allow_rebase_merge          = false
  allow_auto_merge            = false
  allow_update_branch         = false
  delete_branch_on_merge      = true
  squash_merge_commit_title   = "PR_TITLE"
  squash_merge_commit_message = "BLANK"
  merge_commit_title          = "MERGE_MESSAGE"
  merge_commit_message        = "PR_TITLE"
  web_commit_signoff_required = false

  # Destroying this resource must never delete the repository: Terraform
  # refuses to plan it while this block exists, and the provider would archive
  # rather than delete. Stop managing it with a removed block instead.
  archive_on_destroy = true

  lifecycle {
    prevent_destroy = true

    # Not adopted: presentation metadata, settings managed by their own
    # resources, and attributes that only apply when creating a repository.
    ignore_changes = [
      description,
      homepage_url,
      topics,
      pages,
      security_and_analysis,
      vulnerability_alerts,
      default_branch,
      has_downloads,
      template,
      auto_init,
      gitignore_template,
      license_template,
    ]
  }
}

resource "github_branch_default" "analyzer" {
  repository = github_repository.analyzer.name
  branch     = "main"

  lifecycle {
    prevent_destroy = true
  }
}
