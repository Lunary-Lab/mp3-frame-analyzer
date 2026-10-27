# Security model

## Threat model

The endpoint processes **untrusted binary files**. The primary risks are malformed MP3 structure causing incorrect traversal, denial of service through buffering or CPU consumption, huge metadata lengths, malicious multipart bodies, and accidental leakage of inputs in logs.

Controls:

- One streamed raw MP3 or one multipart `file` part; multipart text fields and extra parts are not supported.
- Explicit per-file 50 MiB default limit, configurable with `MAX_UPLOAD_BYTES`, maximum 1 file, zero text fields, one part, 32 multipart header pairs and an 8 KiB header-buffer bound. Startup requires a positive safe integer in decimal bytes; invalid values fail before listening. The same file limit is injectable through `buildApp({ maxUploadBytes })` for embedded use and boundary tests. `headerSize` bounds retained multipart header data; it is not a promise of HTTP 413 for every oversized header. Busboy supports this option at runtime even though the multipart plugin declaration omits it. The formerly configured `fieldNameSize` did not apply to multipart input.
- An already observed multipart file-size truncation is reported as HTTP 413 rather than a parser error caused by the truncated bytes. This does not give a future limit violation precedence over an earlier MPEG error. Rejected MIME/field-name uploads are consumed without buffering to avoid stalling multipart parsing.
- Early MIME filtering followed by actual MPEG header validation. Filename is never used as a path.
- Bounded lookahead, integer-safe offsets, per-frame range validation, deterministic termination and strict EOF handling.
- Structured typed parser failures; generic JSON for unexpected exceptions. Application logs use an explicit field and message allowlist; see the logging boundary below.
- Listener binds only to `127.0.0.1` by default. Configurable bind address for intentional external deployment.
- No spawning external binaries, decoding audio, disk writes, database, shell, or credentials.
- CI audits both the production tree and the complete development/build tree, failing on moderate-or-higher advisories. A weekly workflow repeats these audits. It also runs full-Git-history Betterleaks secret scanning, maintained `eslint-plugin-security` rules in `src/`, and local Semgrep architecture rules prohibiting dynamic code and process execution. JavaScript build, fuzz, and benchmark tools are covered by ordinary ESLint rules.

## Limitations

No authentication, authorization, quotas per identity, or distributed rate limiting are included because this is a local assessment API rather than a published multi-tenant service. In a public deployment, add a reverse proxy with global request-body caps, per-IP/identity rate limiting, TLS termination, visibility into concurrency and throughput, and idle connection controls.

Fastify's multipart `fileSize` limit is **not** an aggregate HTTP-body limit. A separate application guard now counts every transfer-decoded multipart body byte, including rejected/discarded data and epilogue. `MAX_MULTIPART_BYTES` (or `buildApp({ maxMultipartBytes })`) defaults to the configured per-file limit plus 64 KiB, saturating at the maximum safe integer. This project-policy allowance is configurable with the same positive-decimal startup validation as `MAX_UPLOAD_BYTES`; a smaller aggregate cap is permitted. It is not an HTTP/MPEG requirement.

An oversized multipart `Content-Length` rejects before reading with sanitized `413 request-too-large` and `Connection: close`. A streaming crossing holds input paused and closes after the already chosen response. The pipe remains attached so normal buffered EOF still reaches the multipart parser; a failure-only resume guard prevents downstream backpressure release from restarting body delivery. Earlier audio errors are not replaced by later limit faults. The crossing chunk can still reach the parser and Node/kernel buffers can read ahead: this is **not** a strict network-byte cap or arbitrary Content-Encoding decompression limit. Use an ingress proxy for transport-level caps, rates and concurrency controls.

Lefthook checks staged secret content when explicitly installed by the developer. A missing Betterleaks binary fails the hook; GitHub Actions runs the history scan independently so bypassing local hooks does not bypass CI.

The static checks complement behavioral tests; they do not establish comprehensive vulnerability coverage. The security lint rule `detect-object-injection` is disabled because this binary parser deliberately indexes validated byte arrays and fixed tables; the rule cannot establish whether an index is safely bounded. The remaining recommended security rules stay enabled. A public deployment still needs host/container hardening, deployment-specific threat modeling, sustained load testing, and incident monitoring.

When a consumer rejects multipart input early, its error can respond before the remainder arrives. Remaining file bytes drain in the background only while the aggregate body budget and transport timeouts permit. Successful early consumers instead await draining and form validation before acceptance, including file-size and empty-file checks. Every started consumer iterator is closed on early return/rejection; normal EOF completes it without redundant cleanup. Cleanup rejection after success fails the operation; secondary cleanup rejection is logged without replacing an earlier error. Raw early success and failure both close after the response rather than drain. This API cannot stop arbitrary detached tasks inside a custom consumer.

The runtime observes shutdown failures and allows up to 10 seconds for requests and close hooks to drain. A failed close or expired deadline is logged and ends the process with a failure status. Connection-level failures and aborted requests cannot always receive JSON.

The HTTP route gives its actual parser consumer an `AbortSignal`. An incomplete
request closing, the response closing, or an early response finishing cancels
still-running cooperative parser work. Normal request EOF is not cancellation,
including Node's normal completed-request `close` event. Listeners remain attached
to the consumer after an aggregate multipart-budget response wins its race, and
are removed when that consumer settles. Cancellation does not replace an already
chosen 413 response; a disconnected client cannot receive a new error response.
Graceful shutdown does not preempt accepted work before transport teardown. This
is cooperative cancellation at parser checkpoints, not a promise to interrupt
arbitrary synchronous code or detached custom-consumer tasks.

## Application logging boundary

`src/logging.ts` limits application logs to server-generated request correlation IDs,
status codes, elapsed time, process metadata and static event messages. Request
objects are empty and error objects contain only fixed placeholders: raw paths,
queries, Host/other request headers, filenames, audio/tag bytes, and arbitrary
error messages, names, codes, stacks and causes are not emitted. Unknown framework
messages become `Application event`; startup retains a readiness message without
the bind address. The application never accepts a caller's request-ID header as
its log correlation ID. The policy applies whenever logging is enabled, not only
when `NODE_ENV=production`.

`tests/logging.test.ts` enables the real production logger and exercises synthetic
payload/tag/filename/header/query sentinels through successful raw/multipart
uploads, rejected options, method/route errors and unexpected failures. It also
checks that generated IDs, HTTP status/duration and safe lifecycle/error categories
remain observable. Detailed exception traces are deliberately unavailable in
these logs; investigate with synthetic inputs rather than enabling payload logging.

This boundary does not configure ingress/access logs, host or crash diagnostics,
log collectors, retention, access control, tamper protection, authenticated actor
identity, or review/alerting. Operators must verify those separately before
processing sensitive audio. The local assessment API is not an ePHI deployment,
and these safeguards do not establish HIPAA compliance. No uploaded audio is
written to a temporary file by this application; host swap, core dumps and proxy
buffering remain deployment concerns, and garbage collection is not secure erasure.

## npm bootstrap integrity

Before any project dependency install, CI verifies the npm CLI bundle against a
committed SHA-512 SRI pin. `scripts/bootstrap-npm.mjs` accepts only the existing
reviewed versions 11.19.0 and 11.9.0, downloads from the exact official registry
URL with no redirects and bounded time/size, and rejects a missing or mismatched
hash before extraction or execution. npm's bundled dependencies are inside that
same verified archive. There is no global npm install, secondary dependency
resolution, or lifecycle script execution during bootstrap. Project installation
retains its existing explicit `--ignore-scripts` policy; this change does not
silently alter local `npm ci` behavior or remove working native tools.

On Linux/macOS with Node and GNU tar, match CI without modifying a global install:

```bash
verified_npm_bin="$(node scripts/bootstrap-npm.mjs 11.19.0)" &&
  export PATH="$verified_npm_bin:$PATH" &&
  npm --version
```

An optional second argument supplies a previously downloaded archive for offline
bootstrap; the same committed SRI is mandatory. The command prints its temporary
bin directory and adds it to `GITHUB_PATH` in Actions. For local use, retain the
random temporary directory while using npm, then remove its `mp3-verified-npm-*`
parent when finished.

Actions instead requires an absolute `RUNNER_TEMP` and exclusively creates a
bundle-version-and-digest directory beneath it. An existing directory, file or
symlink is rejected, never reused or deleted. This avoids introducing a random
PATH component into mutation-cache environment identity. A runner path/image
change still correctly invalidates reuse; this is not a guarantee of a cache hit.
The [runner's temporary-directory cleanup](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)
owns CI cleanup at job boundaries. Normal project imports/CLIs/plugins still use
the project lockfile; no npm dependency was found unused in this review.

The two pins were checked on 2026-10-26 against official npm registry metadata,
valid registry ECDSA signatures, and the downloaded tarballs. A version update
requires independently verifying the new bundle/signature and reviewing its pin;
never replace a failed digest with the observed bytes merely to make CI pass.
Hash identity does not establish package benignness, CVE safety, or an immutable
hosted runner/Node/tar. See [npm registry signatures](https://docs.npmjs.com/about-registry-signatures/).

## Semgrep installation integrity

The Semgrep CE install uses the complete reviewed version/SHA-256 wheel lock in
`.github/security/semgrep-requirements.txt`: 66 scanner and transitive
distributions for CPython 3.12 on Linux x86_64. Other interpreter/platform targets
fail explicitly; this is not a universal lock. Native
[pip hash-checking mode](https://pip.pypa.io/en/stable/topics/secure-installs/)
checks every archive before installation. Binary-only downloads from PyPI are
followed by a hash-required offline install and `pip check`; source builds and
their separately resolved build dependencies are not allowed. Python isolated
mode, pip isolated mode and `PIP_CONFIG_FILE=/dev/null` prevent accidental local
configuration or environment overrides. The scan still uses only repository
rules, with optional metrics, version checks and tracing disabled.

`scripts/test-semgrep-lock.py` exercises native pip against the downloaded
wheels without network access. It checks the complete graph and rejects wrong or
missing hashes, a modified wheel, an omitted or newly introduced transitive
dependency, and a source-only package without executing its build backend.

To update, resolve the complete wheel graph for the same target, review package
versions and official PyPI metadata against the actual wheel SHA-256s, update the
whole lock, then repeat the native install, failure controls and scanner checks.
Do not replace a failed hash with the newly observed value merely to pass CI.
Hashes prevent substitution relative to reviewed bytes, not malicious upstream
code. The hosted runner, Python and pip remain trusted platform infrastructure,
not immutable dependencies covered by this wheel lock.

## Build dependencies and release credentials

`@stryker-mutator/core@10.1.1` depends on `typed-rest-client@2.3.1`, which pins a vulnerable `qs@6.15.1`. The package override is scoped to **that parent's `qs` dependency**, selecting patched `6.16.1`; it does not force a major update of the parent client. Full mutation testing verifies the resulting toolchain. Remove the override when a compatible upstream Stryker dependency chain includes the fix ([stryker-js#6177](https://github.com/stryker-mutator/stryker-js/pull/6177)), then regenerate the lockfile and rerun mutation and audit checks. A tooling test fails when the locked parent stops pinning the vulnerable version, so the override cannot silently outlive its purpose.

There is no advisory exception list today. If a future finding cannot immediately be fixed, record the advisory, reachability analysis, owner, expiry date, and compensating controls in a reviewed change. Do not lower the audit threshold or use `npm audit fix --force` merely to make CI green.

Validation uses read-only tokens and nonpersistent checkout credentials. Release Please's write token only runs a pinned action; workflow dispatch has separate `actions: write` jobs. Artifact validation runs with read permissions. Only the provenance job receives OIDC/attestation permissions, and only publication can attach assets and publish a draft. PR-title validation uses `pull_request_target` solely to inspect metadata, with read-only permission and no checkout or PR-code execution. See [release operation details](releasing.md).

### Hostile async iterators

The streaming parser bounds consecutive zero-length chunks and validates incoming
chunk types. This prevents a malformed or custom async iterable from spinning
forever without consuming a byte. On an early parse failure, iterator cleanup
errors cannot mask the primary domain error. Fastify already emits nonempty
Buffer chunks under normal operation; these guards protect the parser boundary.

## Raw streaming boundary

Raw MP3 content types are passed directly as Node streams by Fastify, not buffered by `parseAs: 'buffer'`. An independent chunk-by-chunk size limiter enforces the same configured cap as multipart (50 MiB by default) even without `Content-Length`. Oversize known-length raw requests are rejected immediately with `Connection: close`, without draining their remaining payload. Query parameter `includeVbrHeaderFrame` accepts literal `true` and `false` only. Omitted/`false` excludes one recognized initial metadata frame; `true` counts all physical frames. Both policies traverse the input and reject malformed boundaries; neither trusts a metadata-declared frame count. Free-format frame-boundary inference reads at most about 8.7 KiB of bounded lookahead and does not scan arbitrarily long audio data to find a candidate sync. Its unique best-score choice is not proof that every alternative header-only framing has been ruled out.

## HTTP error classification and connection lifecycle

`errorResponseFor` in `src/error-response.ts` maps Fastify 5 and `@fastify/multipart` 10.1.6 **typed error codes** to stable, sanitized JSON. The multipart plugin uses HTTP 413 not only for file size but also for its file-count, field-count, and part-count limits. These expose distinct codes `file-too-large`, `too-many-files`, `unexpected-fields`, and `too-many-parts`. Unknown framework 4xx errors preserve their HTTP category but never return internal messages or falsely claim to be multipart-specific.

When an incomplete multipart ending is the observed failure, it maps to HTTP 400 `invalid-upload`. Known Busboy premature-ending messages and Node's `ERR_STREAM_PREMATURE_CLOSE` from the multipart reader receive that classification. If MPEG validation has already rejected the file, its response is not replaced by a later error while draining the remainder: for example, an early invalid MPEG header can produce 422 before the missing multipart ending arrives. The single-burst cutoff cases in `tests/security.test.ts` cover the 400 path; `tests/http.e2e.test.ts` covers an early 422 followed by an unterminated form during draining. These cases do not establish one status for every arrival order. A client disconnect may leave no writable response.

An empty named file is HTTP 400 `empty-file`; a nonempty but malformed MPEG file remains HTTP 422. For `POST /file-upload`, unsupported MIME types are 415 whether rejected by the upload module or before the handler by Fastify. The API explicitly returns HTTP 405 with `Allow: POST` for other methods on `/file-upload`; unknown routes return JSON 404. Application-generated errors never include parser internals beyond the existing typed MPEG error messages. Unknown routes and unsupported methods close after their existing JSON 404/405 response when a framed request body is still incomplete, rather than draining outside the upload limits. Requests without a body and already completed bodies retain keep-alive reuse. This does not bound all TCP connections or eliminate transport read-ahead; deployment ingress protections remain necessary.

Early rejection of **raw** uploads closes the HTTP/1.1 connection after responding rather than consuming an unbounded remainder. This prevents attackers from using an invalid first header to force a background drain. A raw request that was cancelled at the TCP layer may be impossible to answer; these are not silently converted into HTTP 500. Multipart early rejection permits pipelining and connection reuse only when the entire body finishes within the separate aggregate body budget and transport timeouts. The per-file limit alone does not bound discarded bytes.

For network framing violations (e.g., a client advertises more bytes in `Content-Length` than it sends before disconnecting), native Node may close the connection without an application JSON error. Error precedence is **first observable failure**, not a guarantee that a subsequent size limit overrides early MPEG validation. A public service would still need reverse-proxy aggregate body limits, client-rate controls and ingress timeouts.

## Upload admission

`MAX_ACTIVE_UPLOADS` bounds accepted upload lifetimes per app/server instance
(default 8; decimal 1–1024). An exhausted cap rejects immediately with sanitized
503, `Retry-After: 1`, and connection closure after the response, without draining
an unread rejected request or adding it to a queue. A slot is held through raw
transport completion/closure, response completion/closure, and all upload-owned
consumer/parts/drain settlement. Admission awaits the primary operation before
calling `Uploads.waitForIdle(request)` for remaining multipart parsing/draining
work. That helper is not an independent raw-consumer barrier and never replaces
the primary HTTP result with a cleanup error. It cannot track arbitrary detached
work spawned by a custom consumer. WeakMap state is
request-scoped and cleared on settlement. A set of active transports is capped
by the admission limit and cleared as slots release; there is no growing history.
After transport teardown, `onClose` destroys any buffered unread request
remainders and a barrier waits for all admitted work to
settle; the deployed server still bounds total shutdown with `closeWithDeadline`.
Embedded callers should likewise apply a shutdown deadline.

The limit is not identity fairness, a request-rate limiter, a universal memory
ceiling or a distributed quota. Slow clients can occupy all slots until the
existing transport timeouts; rejected new requests receive no priority. Configure
connection/rate limits at ingress, and tune concurrency using measured workloads.
