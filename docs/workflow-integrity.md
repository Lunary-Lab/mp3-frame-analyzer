# Workflow reference integrity

The required CI lint job runs **zizmor 1.31.1** before its existing actionlint
syntax check. The official Linux x86-64 release archive is verified against a
committed SHA-256 before extraction. A version selector alone is not the pin.
Bootstrap extraction runs with an empty environment and a fixed system-tool
PATH, so `TAR_OPTIONS`/`GZIP` cannot inject extraction commands/options. Curl
configuration is disabled and the job-local tool directory must be created
exclusively, not reused. Native harmless-fixture tests cover these boundaries
and substituted archive rejection through the real hash/extraction commands.
Only the network download is stubbed and the expected archive hash is replaced
with the fixture's digest in those tests; the reviewed production digest stays
unchanged. The shell and runner-supplied system utilities remain the platform
trust boundary.

This changes source CI only; it does not apply Terraform or change GitHub settings.

## Enforced profile

- Every repository workflow (`.yml` and `.yaml`) and every `action.yml` or
  `action.yaml`, including local actions outside `.github`, is discovered from
  Git's tracked and non-ignored new files. Tracked files remain covered even if
  a later `.gitignore` pattern matches them. Symlinked inputs are rejected.
- The native zizmor `unpinned-uses` rule requires full commit references for
  external GitHub Actions and reusable workflows, including composite-action
  steps. Local references are permitted only when their action metadata or reusable
  workflow is present in the discovered repository source inventory. Missing,
  ignored/generated, ambiguous and out-of-repository local targets fail closed;
  symlinked files and ancestor directories are rejected.
- Collection/schema failures, empty input, execution failures, malformed scanner
  evidence and findings hidden by ignore directives cannot produce a pass. The
  scanner runs offline with configuration and ignore rules disabled.
- This repository currently has **no executable container acquisition**. Job
  containers, service containers, Docker actions and `docker://` steps therefore
  fail closed until a separate integrity policy is reviewed. This includes
  already-digested images; it is an explicit unsupported-source policy, not a
  claim that Docker's native SHA-256 scheme is inadequate. The maintained `yaml`
  parser handles quoted/flow syntax, anchors and aliases for this small profile
  check; there is no custom YAML parser.
- Each invocation exercises the installed native scanner with passing full-SHA
  controls and failing tag, branch, abbreviated/dynamic/missing-ref, suppression,
  reusable-workflow, newly discovered composite, Docker and malformed-input cases.

Run the same gate locally after installing locked development dependencies:

```bash
node scripts/verify-workflow-pins.mjs /path/to/verified/zizmor
```

## Why these tools

Zizmor owns workflow parsing and GitHub-reference analysis. Its current image
audit does not cover Docker steps inside composites and accepts some incomplete
digest syntax, so it is not presented as sufficient for all future containers.
The small `yaml`-based unsupported-source check closes that demonstrated gap.
`yaml` is one exact-version, SHA-512-locked development dependency with no runtime
dependencies. The upstream zizmor Action does not expose the strict-collection,
no-configuration and no-ignore controls required here; using its maintained CLI
with a verified archive preserves those guarantees.

This is a **pinning gate**, not an assertion that every zizmor advisory is a
blocking vulnerability. The summary separately counts its other findings.
Existing actionlint, secrets, Semgrep, dependency scans, release gates and all
other required checks remain intact. In particular, metadata-only PR-title
validation intentionally uses `pull_request_target` without checking out PR
code; local `./` actions intentionally follow the exact checked-out CI source.

Hash pins bind expected bytes/source, not publisher trust or vulnerability
freedom. This gate does not inspect arbitrary shell downloads, remote Actions'
internal acquisition, or hosted runner software. npm, Python/Go tools and
Terraform dependency policies are separate controls. Fresh vulnerability
databases remain live data, not frozen executable dependencies.

Primary sources, reviewed 2026-10-26:

- [zizmor 1.31.1 release](https://github.com/zizmorcore/zizmor/releases/tag/v1.31.1)
- [Native reference audit](https://github.com/zizmorcore/zizmor/blob/v1.31.1/crates/zizmor/src/audit/unpinned_uses.rs)
- [Native image audit](https://github.com/zizmorcore/zizmor/blob/v1.31.1/crates/zizmor/src/audit/unpinned_images.rs)
- [zizmor usage and failure modes](https://docs.zizmor.sh/usage/)
- [yaml parser documentation](https://eemeli.org/yaml/)

Zizmor is MIT-licensed; yaml is ISC-licensed. No scanner findings or source files
are uploaded by this gate.
