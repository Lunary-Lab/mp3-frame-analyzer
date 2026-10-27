# MP3 frame analyzer

A small, streaming TypeScript API that **logically counts MPEG-1 Audio Layer III frames**, without invoking an audio decoder or third-party MP3 parsing package. It answers an [MP3 file analysis assessment](docs/assessment-brief.md), kept in this repository as the original brief.

Downloaded a release archive? Start with its **RUNTIME.md**, also available in the [runtime guide](docs/runtime.md). The steps below are for a source checkout.

## Quick start

Requirements: **Node.js 24 LTS** (Node.js 26 is also tested) and **npm 11.9 or later within major 11**. Development and release CI use **npm 11.19.0**, recorded in `packageManager`; the [verified bootstrap](docs/security.md#npm-bootstrap-integrity) selects that exact bundle by SHA-512 without a global install. Dependencies are locked in `package-lock.json`; use `npm ci` for reproducible installation. The repository `.npmrc` deliberately disables automatic dependency/root lifecycle scripts, matching CI; native platform packages remain installed from the exact lock. Hooks are opt-in with `npm run hooks:install`, not installed by dependency postinstall.

```bash
npm ci
npm run build
npm start
```

Default server: `http://127.0.0.1:3000`. Set `HOST` and `PORT` to override; for example `HOST=0.0.0.0 PORT=8080 npm start`.

### Upload-size configuration

Set `MAX_UPLOAD_BYTES` to override the **50 MiB (52,428,800 bytes)** default for the
server started by `npm start` or `npm run dev`. For example, to allow 100 MiB per file:

```bash
MAX_UPLOAD_BYTES=104857600 npm start
```

The value must contain only decimal digits and represent a positive safe integer
from `1` through `9007199254740991` bytes. Leading zeros are decimal, not octal.
An absent variable uses the default; an empty value, whitespace, signs, fractions,
exponents, units, unsafe integers, or `unlimited` fail startup before listening.
The same inclusive limit applies to raw uploads (declared length and streamed
bytes, including chunked transfer) and multipart **file bytes**, not multipart
envelope overhead. Requests over the limit return `413 file-too-large` when the
size violation is observed; an earlier malformed-file error can still win.

Multipart requests also have an **aggregate body budget**: `MAX_MULTIPART_BYTES`,
by default the configured file limit plus **64 KiB** (saturated at the maximum
safe integer). It counts transfer-decoded HTTP body bytes, including multipart
headers, preamble, epilogue and discarded bytes, not just the accepted file.
It uses the same positive-decimal validation and can be lower than the file limit;
then the envelope leaves less room for file bytes. Declared or observed excess
closes the connection and returns `413 request-too-large` unless an earlier
response was already chosen. That earlier status and body are preserved, but
the background drain stops and the connection still closes. This is not
a wire-byte cap: a delivered chunk and transport buffers can contain excess data.

This is a deployment resource policy, not an MPEG format restriction. Raising it
does not change request timeouts, parser behavior, or streaming memory bounds.
For public deployment, configure reverse-proxy aggregate body, concurrency and
rate limits separately. Embedded callers can continue to use
`buildApp({ maxUploadBytes })`; `buildApp()` itself does not read the environment.

### Per-instance upload admission

`MAX_ACTIVE_UPLOADS` defaults to **8** and accepts only decimal integers from
`1` through `1024`; there is no unlimited mode. Embedded callers use
`buildApp({ maxActiveUploads })`. This is a conservative project default, not a
promise that every deployment can sustain eight maximum-sized uploads or that
1024 is a safe setting. Measure your workload before tuning the [runtime limits](docs/runtime.md).

A slot stays occupied until its response and request transport finish **and**
all upload-owned consumers, multipart iterators and background drains settle.
Success, malformed input, abort, timeout and shutdown share this lifecycle.
Overload sends `503` without reading/draining an attacker-controlled remainder,
then closes that connection after the JSON response. `Retry-After: 1` is a retry
hint, not a guarantee of capacity; clients should use bounded backoff with jitter.
There is no priority or per-client fairness guarantee. The cap is per app/server
instance (normally one process), not shared across replicas, and does not bound
all idle TCP connections. Public ingress still needs its own connection/rate policy.

Upload an MP3 as multipart/form-data:

```bash
curl -i -X POST http://127.0.0.1:3000/file-upload \
  -F 'file=@tests/fixtures/cbr.mp3;type=audio/mpeg'
```

Expected successful result for the bundled CBR fixture:

```json
{ "frameCount": 32 }
```

The same endpoint also accepts a raw binary MP3 stream:

```bash
curl -i -X POST http://127.0.0.1:3000/file-upload \
  -H 'Content-Type: audio/mpeg' --data-binary @tests/fixtures/cbr.mp3
```

Both upload modes exclude **one recognized initial** Xing/Info or VBRI metadata frame by default. Explicit `?includeVbrHeaderFrame=false` has the same behavior; append `?includeVbrHeaderFrame=true` to count all physical MPEG frames. Files without a recognized initial metadata frame retain their full count. LAME data is recognized through its Xing/Info header, not as a separate frame.

This is an owner-approved change to the HTTP default and a **breaking API contract change** from the previous physical-frame default. The low-level `countMp3Frames()` function still counts physical frames unless its caller explicitly passes `{ includeVbrHeaderFrame: false }`. The HTTP adapter always passes its selected policy.

The response uses `Content-Type: application/json`. For multipart uploads, the `file` field must be a **single** part. Supported MIME types are `audio/mpeg`, `audio/mp3`, and `application/octet-stream`; MIME is checked only as a preliminary filter, and the file contents must also contain valid MPEG-1 Layer III headers.

### API

| Situation                                                         | HTTP status | Error code / behavior                                                                            |
| ----------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| Valid raw or multipart MPEG-1 Layer III                           | 200         | `{"frameCount":32}` (bundled CBR fixture, default policy)                                        |
| Observed missing/incomplete/malformed multipart, or invalid query | 400         | `missing-file`, `invalid-upload`, `invalid-option`                                               |
| Empty raw or multipart file                                       | 400         | `empty-file`                                                                                     |
| Invalid HTTP body framing / length                                | 400         | `invalid-request` when the connection remains writable                                           |
| MP3 file exceeds per-file limit                                   | 413         | `file-too-large`                                                                                 |
| Multipart body exceeds its separate aggregate budget              | 413         | `request-too-large` unless an earlier response was chosen; connection closes in either case      |
| Extra multipart file / form field / part                          | 413         | `too-many-files`, `unexpected-fields`, or `too-many-parts`, depending on the first limit reached |
| Other framework size limit                                        | 413         | `request-too-large`                                                                              |
| Unsupported MIME or MPEG format                                   | 415         | `unsupported-media-type` or `unsupported-format`                                                 |
| Invalid, malformed, or truncated MP3 content                      | 422         | `invalid-mp3` or `truncated-mp3`                                                                 |
| Unknown route                                                     | 404         | `not-found`                                                                                      |
| Wrong method on `/file-upload`                                    | 405         | `method-not-allowed` with `Allow: POST`                                                          |
| Upload admission exhausted                                        | 503         | `server-busy`, `Retry-After: 1`, connection closes                                               |
| Unexpected application failure                                    | 500         | `internal-error` (sanitized)                                                                     |

All application-generated error bodies use JSON with `error` and `message` strings. Limits apply to both raw and multipart uploads. Error classification follows the **first observable failure**: a malformed MPEG header can be rejected before a later size-limit violation or incomplete multipart ending is observable. An explicit oversized raw `Content-Length` is rejected early. Thus a later 413 or multipart 400 does not replace an already reported 422.

A rejected **raw** upload sends its JSON error with `Connection: close` rather than draining arbitrary additional bytes. Multipart consumer errors may drain for keep-alive reuse, but only if the complete body stays within the aggregate multipart budget and transport timeouts. A multipart-provider failure with unread body bytes closes after its error response because its drain is no longer guaranteed. Client disconnects, aborted/incomplete HTTP bodies, and native Node request-header timeouts may prevent any application JSON response; a client should not expect an HTTP response from a broken connection. An exhausted per-instance admission cap returns sanitized `503 server-busy`, `Retry-After: 1` and `Connection: close` before reading the upload body. No request waits in an application queue. 429 is not configured: this is concurrency admission, not rate limiting.

## Frame-count convention

The endpoint traverses complete MPEG-1 Layer III frames and, by default, excludes a structurally recognized initial Xing/Info/VBRI metadata frame. The included CBR and VBR fixtures each contain 33 physical frames and return **32** by default, matching FFprobe's decoder-facing count for those files. With `?includeVbrHeaderFrame=true`, both return **33**. The count comes from traversal; encoder-declared frame counts are never used as the result.

The evaluator confirmed on **2026-10-26** that the assessment counts audio frames and expects **6089** for the supplied sample, with MediaInfo recommended as a sanity check. The existing API default returns **6089**; explicit physical counting returns **6090**. This structural policy does not decode audio and does not promise agreement with every decoder or metadata tool. The evidence, exact policies and compatibility implications are in [the frame-count contract](docs/frame-count-contract.md).

## Implementation

- `src/mp3/frame-header.ts`: pure MPEG-1 Layer III header decoder: indexed, free-format, unsupported or invalid, with the indexed frame-span formula.
- `src/mp3/frame-spans.ts`: resolves each physical frame's span, discovering and locking a free-format stream's base length.
- `src/mp3/id3.ts`: skips boundary-aligned ID3v2.2/2.3/2.4 tags and final ID3v1 by their encoded lengths, enforcing where each may appear.
- `src/mp3/byte-reader.ts`: incremental lookahead and skipping over any `AsyncIterable<Uint8Array>`.
- `src/mp3/count-frames.ts`: sequential frame traversal with no full-file buffering.
- `src/upload.ts`: raw and multipart uploads, file limits and consumer cleanup; `src/multipart-budget.ts` bounds the complete multipart body, including background drains.
- `src/error-response.ts`: one pure mapping from any failure to a stable, sanitized JSON error response.
- `src/app.ts`: Fastify route, query option, response schemas, and error-handler wiring.
- `src/server.ts`: configurable server bootstrap and graceful signal handling.

Complexity: **O(n)** time and **O(max upstream chunk size)** additional memory. Frame headers require only four bytes of lookahead, and metadata content is streamed past rather than accumulated.

The parser detects free-format frame spacing using multiple consecutive compatible MPEG headers instead of a bitrate-table lookup. The parser rejects invalid data at the next required frame boundary. It does not resynchronize after corrupt frames or arbitrarily skip noise before the first header: doing so can silently turn a malformed upload into a plausible but wrong count. It supports consecutive ID3v2 tags at each MPEG boundary, including embedded tags; every appended tag must be v2.4 with a matching footer, followed by an optional final ID3v1. **Free-format MPEG-1 Layer III** (bitrate index zero) is supported with bounded inference of fixed frame spacing and per-frame padding; one-/two-frame streams can use bounded EOF or metadata-boundary evidence, while tied or conservatively ambiguous candidates return 415. Successive sample-rate configurations inside one uploaded file follow the [bounded sequence policy](docs/specifications/successive-sequences.md); competing layouts produce an explicit ambiguity error. Multiple uploaded files remain rejected. This structural heuristic cannot distinguish every truncated or extended singleton from a complete frame; see the [precise inference contract](docs/specifications/mpeg-1-layer-iii.md#4-free-format-layer-iii-bitrate-index-zero). Table-defined bitrates 32–320 kbps remain supported. Other unsupported scope includes MPEG-2/2.5, Layers I/II, APE/Lyrics3 trailers, audio decoding, and CRC validation.

## Verification

```bash
npm run check              # format + ESLint + strict typecheck + coverage tests + build
npm test                   # unit / property / integration / real HTTP E2E
npm run test:coverage
npm run test:fuzz          # builds first, then deterministic mutation smoke (2,000 inputs)
FUZZ_CASES=10000 npm run test:fuzz
npm run fuzz:regression    # replay tracked and generated Jazzer cases
npm run fuzz:coverage      # 8 seconds per target, coverage-guided
npm run fuzz:extended      # 120 seconds per target, on-demand
npm run test:memory        # distinct chunks, independent 8/32/128 MiB processes
npm run test:performance   # two local 32 MiB uploads plus small-upload probes
npm run bench              # Vitest Bench microbenchmark
npm run mutation           # Full parser; native same-input result reuse
npm run mutation:full      # Force every mutant to execute; 100% adjusted gate
```

`tests/` includes deterministic binary fixtures, structured property testing with fast-check, actual FFmpeg-encoded MP3s, HTTP injection tests, and a real TCP upload test. The mutation smoke harness is separate from the **coverage-guided Jazzer.js 4** targets. A raw-byte target detects crashes and chunk-dependent results; an independent structured-frame generator detects incorrect positive counts. Their seeds, regression corpus, minimizer, and limits are documented in [Fuzzing](fuzz/README.md).

For manual FFprobe comparison:

```bash
ffprobe -v error -select_streams a:0 -count_frames \
  -show_entries stream=nb_read_frames \
  -of default=noprint_wrappers=1:nokey=1 tests/fixtures/cbr.mp3
```

The expected FFprobe output for this fixture is **32**, matching the default HTTP response. Its physical frame count is **33**. See [MP3 counting semantics](docs/architecture.md).

Optional HTTP load test with [k6](https://grafana.com/docs/k6/latest/):

```bash
npm run build && npm start
# In another terminal:
k6 run bench/upload.k6.js
```

## Developer workflow / security

- Node 24, native TypeScript 7 with the TypeScript 6 API compatibility alias, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM.
- ESLint + type-aware `typescript-eslint`, maintained Node security rules for application code, JS/MJS linting for build/fuzz/benchmark scripts, enforced production cyclomatic complexity limits (errors above 10), advisory test complexity warnings above 16, and Prettier. See [code quality limits](docs/code-quality.md).
- Vitest/V8 coverage with enforced thresholds; fast-check properties; mutation smoke, Jazzer.js coverage-guided fuzzing, and replayable crash regressions.
- [Lefthook](https://lefthook.dev/) optional local hooks: `npm run hooks:install`. Pre-commit uses the installed locked Prettier CLI (no `npx` acquisition fallback) for staged formatting and [Betterleaks](https://github.com/betterleaks/betterleaks) staged secrets (v1.9.0). Pre-push runs `npm run check`.
- GitHub Actions CI checks Node 24 and 26, a clean npm 11.9 installation, build/test/type/lint, focused mutation testing, bounded fuzzing, memory scaling, local HTTP measurements, complete and production dependency audits, workflow validation, Git-history secret scanning, fixed-config runtime architecture SAST, and an unpacked release artifact. Weekly dependency audits catch newly published advisories.
- GitHub Actions are pinned to commit SHAs; validation jobs have read-only repository permissions and checkouts do not persist credentials. Dependabot monitors npm and Actions dependencies. Release automation has separate, narrowly scoped write permissions.

The staged secrets hook needs Betterleaks installed locally; the hook fails closed if Betterleaks is unavailable **after you opt in**. Before submission, run `npm ci`, `npm run format:check`, and `npm run check` from a clean checkout. The application itself has no credentials, database, cloud dependencies, or deployment secrets. See [Security model](docs/security.md).

## Versions and releases

[Release Please](https://github.com/googleapis/release-please) derives version bumps and a changelog from **Conventional Commit PR titles**, preserved with **Squash and merge**. `fix:` / `perf:` increment the patch version, `feat:` increments the minor version, and `!` marks a breaking change. Labels do not decide versions. The generated release PR updates the package, lockfile, version manifest, and changelog; a maintainer reviews and merges it to approve a release.

Release CI validates the exact tagged commit and publishes a runtime archive containing compiled JavaScript, a lockfile for production dependency installation, checksums, release metadata, and a production SBOM. It installs and runs the **unpacked archive** before those same bytes can be attached to the GitHub Release. No npm registry publication or production deployment is configured.

```bash
npm run check
npm run package:release    # packages the existing dist/ build; also creates SBOM/checksums
npm run test:artifact      # fresh production install, real upload, graceful shutdown
```

See [Releasing and repository settings](docs/releasing.md) for the enforced GitHub settings, the release approval, permissions, artifact verification, provenance availability, and recovery of an interrupted release.

## Authoritative format specifications and AI agent context

- [Assessment-only requirements and count-policy decision](docs/specifications/assessment-scope.md)
- [AI-agent entry point](AGENTS.md) (also discoverable by [Claude Code](CLAUDE.md) and [GitHub Copilot](.github/copilot-instructions.md))
- [Verified standards and primary-source registry](docs/specifications/README.md)
- [MPEG-1 Layer III header, bitrate table and free-format](docs/specifications/mpeg-1-layer-iii.md)
- [ID3v1/v2 and Xing/Info/LAME/VBRI semantics](docs/specifications/tags-and-encoder-headers.md)
- [HTTP media types and the upload contract](docs/specifications/http-api.md)
- [Supported, limited and out-of-scope conformance matrix](docs/specifications/conformance.md)

The documents distinguish actual ISO/IETF requirements, ID3 informal standards, de facto encoder conventions and deliberate assessment implementation limits. They are concise original summaries with links to original publishers, **not** a copy of the ISO standard or a claim of full MPEG audio-decoder conformance.

## More detail

- [Original assessment brief](docs/assessment-brief.md)
- [Frame-count contract: evidence and open question](docs/frame-count-contract.md)
- [Architecture, frame format and trade-offs](docs/architecture.md)
- [Testing, fuzzing, performance and reproduction](docs/testing.md)
- [Mutation review and equivalent mutants](docs/mutation-review.md)
- [Security assumptions and scope](docs/security.md)
- [Repository governance as code: settings, rulesets and release approval](docs/governance.md)
- [Release process and repository settings](docs/releasing.md)

## Native TypeScript 7 and API compatibility

The build and `typecheck` use **TypeScript 7.0.2's native `tsc`**, while
`typescript-eslint` uses the **TypeScript 6 compiler API** exposed by the
`typescript` npm alias to `@typescript/typescript6`. `tsc6` runs a
secondary compatibility check. This is Microsoft's [official side-by-side
transition guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60);
install with `npm ci`, without `--legacy-peer-deps`.

[TODO.md](TODO.md) tracks removal of the second compiler with a **December 15,
2026 review target**, conditional on stable tooling support.

## Verify the supplied sample

The supplied assessment MP3 is intentionally not redistributed in this
repository. Set its location and execute:

```bash
npm run verify:sample -- /path/to/assessment_sample.mp3
ASSESSMENT_SAMPLE_PATH=/path/to/assessment_sample.mp3 npm run test:coverage
```

The sample SHA-256 is
`97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3`.
The API returns `{"frameCount":6089}` by default and with
`?includeVbrHeaderFrame=false`; `?includeVbrHeaderFrame=true` returns **6090**.
These expectations apply to both raw and multipart uploads. The first MPEG
frame carries the Xing header. FFprobe and MediaInfo also report **6089** for
this file. The evaluator's dated clarification confirms the audio-frame
requirement and sample result 6089. See [the frame-count contract](docs/frame-count-contract.md).

The parser modules have **100% coverage** across statements, branches, functions
and lines using actual edge-case tests. The HTTP adapter retains defensive
branches without manufacturing test-only faults to obtain 100% overall coverage.
See [Testing](docs/testing.md) for mutation testing and security verification.

## Full-parser mutation gate

`npm run mutation` now tests **every parser TypeScript module** under
`src/mp3/**/*.ts`. The raw Stryker JSON report is preserved unchanged. A
separate fail-closed audit requires **100% detection after narrowly reviewed
behaviorally equivalent mutations**. Exceptions match source hashes, exact
expressions, mutation operators and replacements in
[`mutation-equivalents.json`](mutation-equivalents.json), never whole source
lines or mutation families. Native Vitest per-test coverage avoids repeatedly running
unrelated tests. Compatible PRs can reuse native results from an authenticated successful
main baseline. Changed declared source/test/helper/resource/config inputs or a
missing compatible baseline fall back to full; releases and weekly verification
always run full.
Fresh and reused results are counted separately. [Audit design](docs/mutation-review.md)
and [cache safety/verification](docs/mutation-cache.md).
