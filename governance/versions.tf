terraform {
  required_version = "~> 1.16.7"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "6.13.0"
    }
  }

  # State stays on the operator's machine, outside the repository. Pass its
  # location at init with -backend-config=path=...; see docs/governance.md.
  backend "local" {}
}

provider "github" {
  owner = local.owner
}
