# No bypass actors: neither administrators nor automation can skip these
# rules. docs/governance.md describes the audited emergency procedure.
resource "github_repository_ruleset" "main" {
  count = var.enable_rulesets ? 1 : 0

  name        = "main"
  repository  = github_repository.analyzer.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    deletion                = true
    non_fast_forward        = true
    required_linear_history = true
    required_signatures     = var.require_signed_commits

    # One maintainer cannot approve their own pull request, so require the
    # pull request and its checks rather than an approving review.
    pull_request {
      required_approving_review_count   = 0
      dismiss_stale_reviews_on_push     = true
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = true
      allowed_merge_methods             = ["squash"]
    }

    # Native queue validation owns the changing base. One candidate at a time
    # avoids speculative full campaigns and lets later PRs wait behind it.
    merge_queue {
      merge_method                      = "SQUASH"
      grouping_strategy                 = "ALLGREEN"
      max_entries_to_build              = 1
      max_entries_to_merge              = 1
      min_entries_to_merge              = 1
      min_entries_to_merge_wait_minutes = 0
      # The mutation job alone permits 100 minutes, in addition to its needs.
      check_response_timeout_minutes = 180
    }

    required_status_checks {
      strict_required_status_checks_policy = true
      do_not_enforce_on_create             = false

      dynamic "required_check" {
        for_each = var.required_status_checks

        content {
          context        = required_check.value
          integration_id = var.status_check_app_id
        }
      }
    }
  }
}

# Release Please creates each vX.Y.Z tag, so creation stays allowed; nothing
# may move or delete one. Published releases additionally lock their tags.
resource "github_repository_ruleset" "release_tags" {
  count = var.enable_rulesets ? 1 : 0

  name        = "release-tags"
  repository  = github_repository.analyzer.name
  target      = "tag"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/tags/v*"]
      exclude = []
    }
  }

  rules {
    creation         = false
    update           = true
    deletion         = true
    non_fast_forward = true
  }
}
