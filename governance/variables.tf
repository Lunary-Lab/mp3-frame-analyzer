locals {
  owner      = "Lunary-Lab"
  repository = "mp3-frame-analyzer"
}

variable "enable_rulesets" {
  description = "Enforce the main-branch and release-tag rulesets. Disable only to recover from an emergency (docs/governance.md)."
  type        = bool
  default     = true
}

variable "require_signed_commits" {
  description = "Require verified signatures on main. Off because an automated contributor cannot sign its pull request commits, and GitHub can refuse to squash merge a branch containing unsigned commits. GitHub still signs every squash merge it creates."
  type        = bool
  default     = false
}

variable "required_status_checks" {
  description = "Check runs every pull request and merge group into main must pass. Each must be a job name in a workflow that runs for both events."
  type        = list(string)
  default     = ["All checks", "Conventional Commit PR title"]

  validation {
    condition     = length(var.required_status_checks) > 0
    error_message = "Require at least one status check."
  }
}

variable "status_check_app_id" {
  description = "GitHub App that must report the required checks: GitHub Actions (15368), as observed on this repository's check runs."
  type        = number
  default     = 15368
}

variable "aggregate_status_check" {
  description = "Required check that fails unless every validation job in its workflow succeeded."
  type        = string
  default     = "All checks"
}

variable "title_status_check" {
  description = "Required check that validates PR metadata and must rerun when the title is edited."
  type        = string
  default     = "Conventional Commit PR title"
}

variable "workflow_directory" {
  description = "Workflows that the required checks are verified against."
  type        = string
  default     = "../.github/workflows"
}
