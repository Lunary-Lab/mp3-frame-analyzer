# Local Trivy vulnerability gate

Ordinary PR/push/scheduled CI and release validation require both visible Trivy jobs through the fail-closed `All checks` aggregate. Publication still requires the existing release owner's approval. No repository setting or Terraform apply is needed: the required check name stays `All checks`.

## Coverage and failure policy

- Trivy **0.76.1** scans the complete lock-v3 inventory with development dependencies, aliases, transitive dependencies and all optional/platform package versions. A second job reads the exact previously tested release archive, checks all asset checksums and its source identity, requires the packaged lock to equal the source lock, and scans its production subset. It does not reinstall dependencies or rebuild the artifact.
- The emitted native package inventory must equal every expected unique name/version. All original lock paths are retained when reporting a finding. Missing/extra target or package coverage, invalid schema/version/severity, process failure and missing/stale DB evidence are blocking.
- **HIGH and CRITICAL block even when no fix exists. UNKNOWN also blocks** rather than treating missing classification as safe. npm's existing independent moderate+ gate remains unchanged. There are no CVE exemptions, ignore files, `ignore-unfixed` flags, or environment-controlled severity reductions.
- Every invocation uses a fresh private database/cache directory, verifies schema 2, download time, update age (at most 24 hours), and a future `NextUpdate`. The actual database SHA-256 and lock/archive hashes are logged. The DB is refreshed, not permanently pinned or reused from PR artifacts.
- Native controls use only a synthetic lock entry for `lodash@4.17.20` (no package download/execution): the installed scanner/current DB must detect a blocking vulnerability, and the actual missing-DB invocation must fail. Unit controls cover partial inventory, malformed severities, deadlines, hostile environment, wrong versions and process failures.

## Data minimization and integrity

The binary archive is pinned by SHA-256 `c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0`, verified before extracting only `trivy`. This digest was rechecked against the official 0.76.1 checksum file on 2026-10-26. Changing the version/digest requires review.

Unavoidable requests: GitHub release delivery (`github.com` and its HTTPS release-asset CDN) downloads the scanner; `ghcr.io/aquasecurity/trivy-db:2` and GitHub's OCI blob delivery download the vulnerability database. Registry requests expose the requested public tool/DB resource, normal connection/header information and runner IP, **not the project dependency inventory or source**. GitHub runner/action/checkout and existing release-artifact transport remain part of CI.

Only local lock files are compared against the local database. Supported `--disable-telemetry --skip-version-check` disable optional usage/update traffic. During scans, `--offline-scan --skip-db-update --skip-java-db-update --skip-check-update --skip-vex-repo-update`, `--scanners vuln`, a private working directory/HOME and an allowlisted environment prevent ambient scanner servers, ignore config, credentials or optional checks from being selected. This is configuration-based network minimization, not a claim of kernel egress isolation. Necessary HTTPS proxy/CA settings may be inherited; Actions tokens and other secrets are not passed to the scanner.

No remote scan server, source/secret scanner, SARIF publication, VEX upload, raw scanner report or additional artifact upload is used. Public logs contain bounded provenance and blocking advisory/package/version/path identities only; those identities are not private. Temporary raw scanner/DB files are removed on completion. Job and subprocess time/output limits fail closed.

Trivy finds known dependency vulnerabilities, not arbitrary malicious behavior or proof of security. GuardDog's separate workstream is complementary. Any future false-positive exemption must be independently investigated and committed with exact advisory/package/version/lock-path/scope, evidence, owner and review/expiry; this gate currently accepts **none**.

Official sources verified 2026-10-26: [release](https://github.com/aquasecurity/trivy/releases/tag/v0.76.1), [npm lock coverage](https://trivy.dev/docs/latest/coverage/language/nodejs/), [telemetry opt-out](https://trivy.dev/docs/latest/advanced/telemetry/), [network resources](https://trivy.dev/docs/latest/advanced/air-gap/).
