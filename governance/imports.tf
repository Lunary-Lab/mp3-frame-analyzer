# Adopt the existing repository and settings. Import blocks are idempotent:
# once a resource is in state they do nothing. With an empty or lost state they
# rebuild it from GitHub; docs/governance.md lists the two provider-local
# updates that a fresh import also plans.
import {
  to = github_repository.analyzer
  id = local.repository
}

import {
  to = github_branch_default.analyzer
  id = local.repository
}

import {
  to = github_actions_repository_permissions.analyzer
  id = local.repository
}

import {
  to = github_workflow_repository_permissions.analyzer
  id = local.repository
}

import {
  to = github_repository_vulnerability_alerts.analyzer
  id = local.repository
}

import {
  to = github_repository_dependabot_security_updates.analyzer
  id = local.repository
}
