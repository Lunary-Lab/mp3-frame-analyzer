resource "github_repository_vulnerability_alerts" "analyzer" {
  repository = github_repository.analyzer.name
  enabled    = true
}

resource "github_repository_dependabot_security_updates" "analyzer" {
  repository = github_repository.analyzer.name
  enabled    = true

  depends_on = [github_repository_vulnerability_alerts.analyzer]
}
