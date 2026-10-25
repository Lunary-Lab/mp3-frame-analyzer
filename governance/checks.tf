# Required checks must come from jobs that report under their own name on
# every pull request into main. Requiring a check that never reports blocks
# every merge, and GitHub counts a skipped check as passing.
locals {
  always_conditions          = ["always()", "$${{ always() }}"]
  commit_changing_activities = ["opened", "synchronize", "reopened"]
  pull_request_events        = ["pull_request", "pull_request_target"]
  pull_request_skip_filters  = ["paths", "paths-ignore", "branches", "branches-ignore"]

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

  # Paths or branches filters can leave a pull request without the check, and
  # a types list must include every activity that adds or changes commits.
  every_pull_request_workflows = [
    for name, filters in local.pull_request_filters : name
    if length(filters) > 0 && alltrue([
      for filter in filters :
      length(setintersection(keys(filter), local.pull_request_skip_filters)) == 0 &&
      length(setsubtract(local.commit_changing_activities, try(filter.types, local.commit_changing_activities))) == 0
    ])
  ]

  every_pull_request_jobs = flatten([
    for name in local.every_pull_request_workflows : [
      for id, job in local.workflows[name].jobs : {
        name      = try(job.name, id)
        condition = try(job["if"], null)
        needs     = toset(flatten([try(job.needs, [])]))
        siblings  = setsubtract(keys(local.workflows[name].jobs), [id])
        # Matrix and reusable-workflow jobs report under derived names.
        renamed = try(job.strategy.matrix, null) != null || try(job.uses, null) != null
      }
    ]
  ])

  # A job without a condition still skips when a job it needs fails.
  always_reporting_checks = [
    for job in local.every_pull_request_jobs : job.name
    if !job.renamed && (
      contains(local.always_conditions, coalesce(job.condition, "none")) ||
      (job.condition == null && length(job.needs) == 0)
    )
  ]

  aggregate_jobs = [
    for job in local.every_pull_request_jobs : job
    if job.name == var.aggregate_status_check
  ]
}

output "required_status_checks" {
  description = "Checks the proposed main ruleset requires, each verified against the workflows."
  value       = var.required_status_checks

  precondition {
    condition     = alltrue([for check in var.required_status_checks : contains(local.always_reporting_checks, check)])
    error_message = "Every required check must be an unskippable job, reporting under its own name, in a workflow that runs for every pull request."
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
      contains(local.always_conditions, coalesce(job.condition, "none")) && job.needs == job.siblings
    ])
    error_message = "Exactly one aggregate job must run always() and need every other job in its workflow."
  }
}
