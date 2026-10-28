# Required checks must come from jobs that report under their own name on
# every pull request and merge group into main. A check that never reports blocks
# every merge, and GitHub counts a skipped check as passing.
locals {
  commit_changing_activities = ["opened", "synchronize", "reopened"]
  pull_request_events        = ["pull_request", "pull_request_target"]
  pull_request_skip_filters  = ["paths", "paths-ignore", "branches-ignore"]

  workflows = {
    for name in fileset(var.workflow_directory, "*.{yml,yaml}") :
    name => yamldecode(file("${var.workflow_directory}/${name}"))
  }

  # `on` may be a string, a list or a map. YAML 1.1 reads a bare `on` key as
  # the boolean true.
  triggers = {
    for name, workflow in local.workflows :
    name => try(workflow["on"], workflow["true"], {})
  }

  pull_request_filters = {
    for name, on in local.triggers : name => [
      for event in try(keys(on), flatten([on])) : coalesce(try(on[event], null), {})
      if contains(local.pull_request_events, event)
    ]
  }

  # Paths and unsupported branch filters can omit the check. An exact main
  # filter is safe because the ruleset only protects main. Do not
  # attempt to interpret arbitrary branch patterns here.
  every_pull_request_workflows = [
    for name, filters in local.pull_request_filters : name
    if length(filters) > 0 && alltrue([
      for filter in filters :
      length(setintersection(keys(filter), local.pull_request_skip_filters)) == 0 &&
      (!contains(keys(filter), "branches") || try(toset(filter.branches) == toset(["main"]), false)) &&
      length(setsubtract(local.commit_changing_activities, try(filter.types, local.commit_changing_activities))) == 0
    ])
  ]

  merge_group_filters = {
    for name, on in local.triggers : name => [
      for event in try(keys(on), flatten([on])) : coalesce(try(on[event], null), {})
      if event == "merge_group"
    ]
  }

  # GitHub requires the same check names on the queue's checks_requested SHA.
  # Only an unfiltered event or an exact main branch filter is supported.
  every_merge_group_workflows = [
    for name, filters in local.merge_group_filters : name
    if length(filters) > 0 && alltrue([
      for filter in filters :
      length(setsubtract(keys(filter), ["branches", "types"])) == 0 &&
      (!contains(keys(filter), "branches") || try(toset(filter.branches) == toset(["main"]), false)) &&
      contains(try(filter.types, ["checks_requested"]), "checks_requested")
    ])
  ]

  # Check-name collisions matter across workflows, including filtered and
  # manually dispatched workflows, not only the eligible required-check jobs.
  workflow_jobs = flatten([
    for name, workflow in local.workflows : [
      for id, job in workflow.jobs : {
        workflow  = name
        name      = try(job.name, id)
        condition = try(job["if"], null)
        # Accept only a bare always() or that same expression inside Actions
        # delimiters, with insignificant surrounding whitespace.
        always = can(regex(
          "^(always\\(\\)|\\$\\{\\{\\s*always\\(\\)\\s*\\}\\})$",
          trimspace(coalesce(try(job["if"], null), "none"))
        ))
        needs    = toset(flatten([try(job.needs, [])]))
        siblings = setsubtract(keys(workflow.jobs), [id])
        # Matrix and reusable-workflow jobs report under derived names.
        renamed = try(job.strategy.matrix, null) != null || try(job.uses, null) != null
      }
    ]
  ])

  every_pull_request_jobs = [
    for job in local.workflow_jobs : job
    if contains(local.every_pull_request_workflows, job.workflow)
  ]

  # A job without a condition still skips when a job it needs fails.
  always_reporting_checks = [
    for job in local.every_pull_request_jobs : job.name
    if contains(local.every_merge_group_workflows, job.workflow) && !job.renamed && (
      job.always ||
      (job.condition == null && length(job.needs) == 0)
      ) && (job.name != var.title_status_check || alltrue([
        for filter in local.pull_request_filters[job.workflow] :
        contains(try(filter.types, local.commit_changing_activities), "edited")
    ]))
  ]

  aggregate_jobs = [
    for job in local.workflow_jobs : job
    if job.name == var.aggregate_status_check
  ]
}

output "required_status_checks" {
  description = "Checks the proposed main ruleset requires, each verified against the workflows."
  value       = var.required_status_checks

  precondition {
    condition = alltrue([
      for check in var.required_status_checks :
      contains(local.always_reporting_checks, check) &&
      length([for job in local.workflow_jobs : job.name if job.name == check]) == 1
    ])
    error_message = "Every required check must have one unique, unskippable job name across workflows and report on every pull request and merge_group checks_requested event into main. The title check must also report on edited events."
  }
}

# The aggregate's own steps must fail on any child result other than success;
# this checks that it always runs and waits for every other job.
output "aggregate_status_check" {
  description = "Required check that stands for every validation job in its workflow."
  value       = var.aggregate_status_check

  precondition {
    condition     = contains(var.required_status_checks, var.aggregate_status_check)
    error_message = "Require the aggregate status check."
  }

  precondition {
    condition = length(local.aggregate_jobs) == 1 && alltrue([
      for job in local.aggregate_jobs :
      contains(local.every_pull_request_workflows, job.workflow) && job.always && job.needs == job.siblings
    ])
    error_message = "Exactly one aggregate job must run always() and need every other job in its workflow."
  }
}
