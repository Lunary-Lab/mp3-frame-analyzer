# Policy tests run offline against a mocked GitHub provider, with the imported
# resources overridden, so nothing here reads or changes GitHub.
mock_provider "github" {}

override_resource {
  target = github_repository.analyzer
}

override_resource {
  target = github_branch_default.analyzer
}

override_resource {
  target = github_actions_repository_permissions.analyzer
}

override_resource {
  target = github_workflow_repository_permissions.analyzer
}

override_resource {
  target = github_repository_vulnerability_alerts.analyzer
}

override_resource {
  target = github_repository_dependabot_security_updates.analyzer
}

run "repository_workflows_satisfy_the_check_contract" {
  command = plan

  assert {
    condition     = output.required_status_checks == tolist(["All checks", "Conventional Commit PR title"])
    error_message = "The real workflows must provide both required checks."
  }
}

run "valid_fixture_satisfies_the_check_contract" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/valid"
  }
}

run "string_and_list_triggers_are_understood" {
  command = plan

  variables {
    workflow_directory     = "tests/fixtures/trigger-forms"
    required_status_checks = ["All checks", "Conventional Commit PR title", "Listed check"]
  }
}

run "nonexistent_required_check_is_rejected" {
  command = plan

  variables {
    workflow_directory     = "tests/fixtures/valid"
    required_status_checks = ["All checks", "Conventional Commit PR title", "Deploy preview"]
  }

  expect_failures = [output.required_status_checks]
}

run "check_filtered_by_paths_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/check-filtered-by-paths"
  }

  expect_failures = [output.required_status_checks]
}

run "check_skipping_new_commits_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/check-types-skip-commits"
  }

  expect_failures = [output.required_status_checks]
}

run "conditionally_skipped_check_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/check-conditional"
  }

  expect_failures = [output.required_status_checks]
}

run "check_skipped_by_a_failed_dependency_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/check-with-needs"
  }

  expect_failures = [output.required_status_checks]
}

run "matrix_check_reporting_under_derived_names_is_rejected" {
  command = plan

  variables {
    workflow_directory     = "tests/fixtures/check-from-matrix"
    required_status_checks = ["All checks", "Conventional Commit PR title", "Matrix check"]
  }

  expect_failures = [output.required_status_checks]
}

run "aggregate_missing_a_child_job_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/aggregate-misses-job"
  }

  expect_failures = [output.aggregate_status_check]
}

# Without always(), a failed child skips the aggregate, and GitHub would count
# the skipped aggregate as passing.
run "aggregate_without_always_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/aggregate-without-if"
  }

  expect_failures = [output.required_status_checks, output.aggregate_status_check]
}

run "aggregate_running_only_on_success_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/aggregate-skippable"
  }

  expect_failures = [output.required_status_checks, output.aggregate_status_check]
}

# Duplicate check names make required-check resolution ambiguous.
run "duplicate_aggregate_is_rejected" {
  command = plan

  variables {
    workflow_directory = "tests/fixtures/aggregate-duplicated"
  }

  expect_failures = [output.required_status_checks, output.aggregate_status_check]
}

run "aggregate_must_be_required" {
  command = plan

  variables {
    workflow_directory     = "tests/fixtures/valid"
    required_status_checks = ["Conventional Commit PR title"]
  }

  expect_failures = [output.aggregate_status_check]
}

run "duplicate_required_name_in_any_workflow_is_rejected" {
  command = plan
  variables { workflow_directory = "tests/fixtures/required-check-duplicated" }
  expect_failures = [output.required_status_checks]
}

run "filtered_duplicate_aggregate_is_rejected" {
  command = plan
  variables { workflow_directory = "tests/fixtures/filtered-aggregate-duplicated" }
  expect_failures = [output.required_status_checks, output.aggregate_status_check]
}

run "title_check_must_report_after_edits" {
  command = plan
  variables { workflow_directory = "tests/fixtures/title-without-edited" }
  expect_failures = [output.required_status_checks]
}

run "main_only_branch_filters_are_accepted" {
  command = plan
  variables { workflow_directory = "tests/fixtures/main-only-branches" }
}

run "filters_excluding_main_are_rejected" {
  command = plan
  variables { workflow_directory = "tests/fixtures/wrong-branch" }
  expect_failures = [output.required_status_checks, output.aggregate_status_check]
}

run "ignoring_main_is_rejected" {
  command = plan
  variables { workflow_directory = "tests/fixtures/ignored-main" }
  expect_failures = [output.required_status_checks]
}

run "compact_always_expression_is_accepted" {
  command = plan
  variables { workflow_directory = "tests/fixtures/always-compact" }
}

run "spaced_always_expression_is_accepted" {
  command = plan
  variables { workflow_directory = "tests/fixtures/always-spaced" }
}

run "rulesets_can_be_disabled_in_an_emergency" {
  command = plan

  variables {
    enable_rulesets = false
  }

  assert {
    condition     = length(github_repository_ruleset.main) == 0 && length(github_repository_ruleset.release_tags) == 0
    error_message = "enable_rulesets = false must remove both rulesets."
  }
}

run "main_ruleset_requires_checks_not_reviews" {
  command = plan

  assert {
    condition     = github_repository_ruleset.main[0].enforcement == "active" && length(github_repository_ruleset.main[0].bypass_actors) == 0
    error_message = "The main ruleset must be active with no bypass actors."
  }

  assert {
    condition = (
      github_repository_ruleset.main[0].conditions[0].ref_name[0].include == tolist(["~DEFAULT_BRANCH"]) &&
      length(github_repository_ruleset.main[0].conditions[0].ref_name[0].exclude) == 0
    )
    error_message = "The main ruleset must target the default branch with no exclusions."
  }

  assert {
    condition = alltrue([
      github_repository_ruleset.main[0].rules[0].deletion,
      github_repository_ruleset.main[0].rules[0].non_fast_forward,
      github_repository_ruleset.main[0].rules[0].required_linear_history,
      !github_repository_ruleset.main[0].rules[0].required_signatures,
    ])
    error_message = "main must block deletion and force pushes and require linear history, without requiring signed commits."
  }

  assert {
    condition = (
      github_repository_ruleset.main[0].rules[0].pull_request[0].required_approving_review_count == 0 &&
      github_repository_ruleset.main[0].rules[0].pull_request[0].dismiss_stale_reviews_on_push &&
      !github_repository_ruleset.main[0].rules[0].pull_request[0].require_last_push_approval &&
      !github_repository_ruleset.main[0].rules[0].pull_request[0].require_code_owner_review &&
      github_repository_ruleset.main[0].rules[0].pull_request[0].required_review_thread_resolution &&
      github_repository_ruleset.main[0].rules[0].pull_request[0].allowed_merge_methods == tolist(["squash"])
    )
    error_message = "Pull requests must need no approving review, dismiss stale approvals, require resolved conversations, and squash merge."
  }

  assert {
    condition = (
      github_repository_ruleset.main[0].rules[0].required_status_checks[0].strict_required_status_checks_policy &&
      !github_repository_ruleset.main[0].rules[0].required_status_checks[0].do_not_enforce_on_create &&
      toset([for check in github_repository_ruleset.main[0].rules[0].required_status_checks[0].required_check : check.context]) == toset(["All checks", "Conventional Commit PR title"]) &&
      alltrue([for check in github_repository_ruleset.main[0].rules[0].required_status_checks[0].required_check : check.integration_id == 15368])
    )
    error_message = "Both checks must be required from GitHub Actions against an up-to-date branch."
  }
}

run "signed_commits_can_be_required_again" {
  command = plan

  variables {
    require_signed_commits = true
  }

  assert {
    condition     = github_repository_ruleset.main[0].rules[0].required_signatures
    error_message = "require_signed_commits = true must add the signature rule."
  }
}

run "release_tags_cannot_move_or_disappear" {
  command = plan

  assert {
    condition = (
      github_repository_ruleset.release_tags[0].target == "tag" &&
      github_repository_ruleset.release_tags[0].enforcement == "active" &&
      github_repository_ruleset.release_tags[0].conditions[0].ref_name[0].include == tolist(["refs/tags/v*"]) &&
      length(github_repository_ruleset.release_tags[0].conditions[0].ref_name[0].exclude) == 0 &&
      github_repository_ruleset.release_tags[0].rules[0].non_fast_forward &&
      github_repository_ruleset.release_tags[0].rules[0].update &&
      github_repository_ruleset.release_tags[0].rules[0].deletion &&
      !github_repository_ruleset.release_tags[0].rules[0].creation &&
      length(github_repository_ruleset.release_tags[0].bypass_actors) == 0
    )
    error_message = "Release tags must be creatable by Release Please but never updated or deleted."
  }
}

run "adopted_settings_keep_squash_only_private_and_read_only_tokens" {
  command = plan

  assert {
    condition = (
      github_repository.analyzer.visibility == "public" &&
      github_repository.analyzer.allow_squash_merge &&
      !github_repository.analyzer.allow_merge_commit &&
      !github_repository.analyzer.allow_rebase_merge &&
      github_repository.analyzer.squash_merge_commit_title == "PR_TITLE" &&
      github_repository.analyzer.squash_merge_commit_message == "BLANK" &&
      github_repository.analyzer.archive_on_destroy
    )
    error_message = "The repository must stay public and squash-only, and archive rather than delete."
  }

  assert {
    condition = (
      github_repository.analyzer.security_and_analysis[0].secret_scanning[0].status == "enabled" &&
      github_repository.analyzer.security_and_analysis[0].secret_scanning_push_protection[0].status == "enabled"
    )
    error_message = "Secret scanning and push protection must be on."
  }

  assert {
    condition = (
      github_workflow_repository_permissions.analyzer.default_workflow_permissions == "read" &&
      github_actions_repository_permissions.analyzer.allowed_actions == "selected" &&
      github_actions_repository_permissions.analyzer.sha_pinning_required
    )
    error_message = "Actions must default to read-only tokens and SHA-pinned, selected actions."
  }
}

run "publication_waits_for_one_owner_approval" {
  command = plan

  assert {
    condition = (
      github_repository_environment.release.reviewers[0].users == toset([98036866]) &&
      length(coalesce(github_repository_environment.release.reviewers[0].teams, [])) == 0 &&
      !github_repository_environment.release.prevent_self_review &&
      !github_repository_environment.release.can_admins_bypass
    )
    error_message = "Only choskeli may approve, admins may not bypass, and the approver may approve their own release."
  }

  assert {
    condition = (
      !github_repository_environment.release.deployment_branch_policy[0].protected_branches &&
      github_repository_environment.release.deployment_branch_policy[0].custom_branch_policies &&
      github_repository_environment_deployment_policy.release_tags.tag_pattern == "v*"
    )
    error_message = "Only v* release tags may deploy to the release environment."
  }
}
