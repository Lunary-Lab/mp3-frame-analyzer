# Security model

## Threat model

The endpoint processes **untrusted binary files**. The primary risks are malformed MP3 structure causing incorrect traversal, denial of service through buffering or CPU consumption, huge metadata lengths, malicious multipart bodies, and accidental leakage of inputs in logs.

Controls:

- Single streamed multipart `file`; fields and extra parts are not supported.
- Explicit per-file 50 MiB production limit, maximum 1 file, zero text fields, one part, bounded multipart header pairs. The limit is injectable for small boundary tests.
- Multipart limit errors take precedence over parser truncation errors (HTTP 413 rather than HTTP 422). Rejected MIME/field-name uploads are consumed without buffering to avoid stalling multipart parsing.
- Early MIME filtering followed by actual MPEG header validation. Filename is never used as a path.
- Bounded lookahead, integer-safe offsets, per-frame range validation, deterministic termination and strict EOF handling.
- Structured typed parser failures; generic JSON for unexpected exceptions. No upload contents or secrets are logged.
- Listener binds only to `127.0.0.1` by default. Configurable bind address for intentional external deployment.
- No spawning external binaries, decoding audio, disk writes, database, shell, or credentials.
- CI includes production dependency audit, full-Git-history Betterleaks secret scanning, and local Semgrep rules prohibiting dynamic code execution / shell execution in `src/`.

## Limitations

No authentication, authorization, quotas per identity, or distributed rate limiting are included because this is a local assessment API rather than a published multi-tenant service. In a public deployment, add a reverse proxy with global request-body caps, per-IP/identity rate limiting, TLS termination, visibility into concurrency and throughput, and idle connection controls.

Fastify's multipart `fileSize` limit is **not** an aggregate HTTP-body limit. The `parts`/`files`/`fields` limits bound multipart resource amplification, but a reverse proxy is the appropriate enforcement point for a strict aggregate cap in public deployment.

Lefthook checks staged secret content when explicitly installed by the developer. A missing Betterleaks binary fails the hook; GitHub Actions runs the history scan independently so bypassing local hooks does not bypass CI.

The focused Semgrep rules are supplemental rather than a claim of comprehensive SAST coverage. A production deployment would additionally conduct threat modeling, host/container hardening, wider SAST rules, periodic dependency review, load testing, and incident monitoring.

### Hostile async iterators

The streaming parser bounds consecutive zero-length chunks and validates incoming
chunk types. This prevents a malformed or custom async iterable from spinning
forever without consuming a byte. On an early parse failure, iterator cleanup
errors cannot mask the primary domain error. Fastify already emits nonempty
Buffer chunks under normal operation; these guards protect the parser boundary.
