# MP3 frame analyzer

A small, streaming TypeScript API that **logically counts MPEG-1 Audio Layer III frames**, without invoking an audio decoder or third-party MP3 parsing package. It answers an [MP3 file analysis assessment](docs/assessment-brief.md), kept in this repository as the original brief.

Downloaded a release archive? Start with its **RUNTIME.md**, also available in the [runtime guide](docs/runtime.md). The steps below are for a source checkout.

## Quick start

Requirements: **Node.js 24 LTS** (Node.js 26 is also tested) and **npm 11.9 or later within major 11**. Development and release CI use **npm 11.19.0**, recorded in `packageManager`; install it with `npm install --global npm@11.19.0` when matching CI exactly. Dependencies are locked in `package-lock.json`; use `npm ci` for reproducible installation.

```bash
npm ci
npm run build
npm start
```

Default server: `http://127.0.0.1:3000`. Set `HOST` and `PORT` to override; for example `HOST=0.0.0.0 PORT=8080 npm start`.

Upload an MP3:

```bash
curl -i -X POST http://127.0.0.1:3000/file-upload \
  -F 'file=@tests/fixtures/cbr.mp3;type=audio/mpeg'
```

Expected successful result for the bundled CBR fixture:

```json
{ "frameCount": 33 }
```

The response uses `Content-Type: application/json`. The `file` field must be a **single** multipart upload. Supported MIME types are `audio/mpeg`, `audio/mp3`, and `application/octet-stream`; MIME is checked only as a preliminary filter, and the file contents must also contain valid MPEG-1 Layer III headers.

### API

| Condition                            | Status | Response                                              |
| ------------------------------------ | ------ | ----------------------------------------------------- |
| Valid MPEG-1 Layer III file          | 200    | `{ "frameCount": 33 }` (example)                      |
| Missing or malformed multipart input | 400    | `{ "error": "missing-file", "message": "..." }`       |
| Unsupported MIME / MPEG format       | 415    | `{ "error": "unsupported-format", "message": "..." }` |
| Multipart limit exceeded             | 413    | `{ "error": "file-too-large", "message": "..." }`     |
| Malformed / truncated MP3            | 422    | `{ "error": "invalid-mp3", "message": "..." }`        |
| Unexpected application failure       | 500    | `{ "error": "internal-error", "message": "..." }`     |

Exact error codes vary with validation failure. Application-generated error bodies use JSON; a connection abort or low-level HTTP timeout can terminate before an application response is possible. Upload size is limited to **50 MiB** with one file part and no text fields; only a syntactically valid file yields a frame count.

## Why the frame count can differ from FFprobe and MediaInfo

This endpoint counts **physical, complete MPEG-1 Layer III frames**. This includes a first MPEG frame containing Xing/Info/VBRI metadata. Such a frame may not carry independently decodable audio; some decoder-facing tools omit it from `nb_read_frames`. The included CBR and VBR fixtures contain 33 physical frames while `ffprobe -count_frames` reports 32 audio frames. The result is derived from frame headers **not** the Xing frame-count field.

This counting convention is explicit because the task asks for the number of frames _in the file_, not only the number of decoded audio packets. **It is not yet confirmed by the evaluator.** The brief suggests MediaInfo for verification, and MediaInfo reports **6089** for the supplied sample (its Xing-declared count), as does FFprobe; this API reports **6090**. The evidence and a ready clarification question are in [the frame-count contract](docs/frame-count-contract.md). Do not silently subtract one: changing the convention is an owner decision.

## Implementation

- `src/mp3/frame-header.ts`: pure MPEG-1 Layer III bit-field decoder and frame-size formula.
- `src/mp3/id3.ts`: ID3v2.2/2.3/2.4 synchsafe tag parsing; excludes ID3v1 tags.
- `src/mp3/byte-reader.ts`: incremental lookahead and skipping over any `AsyncIterable<Uint8Array>`.
- `src/mp3/count-frames.ts`: sequential frame traversal with no full-file buffering.
- `src/app.ts`: Fastify multipart route, response schemas, limits, and stable JSON errors.
- `src/server.ts`: configurable server bootstrap and graceful signal handling.

Complexity: **O(n)** time and **O(max upstream chunk size)** additional memory. Frame headers require only four bytes of lookahead, and metadata content is streamed past rather than accumulated.

The parser rejects invalid data at the next required frame boundary. It does not resynchronize after corrupt frames or arbitrarily skip noise before the first header: doing so can silently turn a malformed upload into a plausible but wrong count. It supports up to eight leading ID3v2 tags, one appended ID3v2.4 tag with a matching footer, then an optional final ID3v1 tag. **Free-format MPEG-1 Layer III** (bitrate index zero) is a valid but unsupported subtype and returns 415; table-defined bitrates 32–320 kbps are supported. Other unsupported scope includes MPEG-2/2.5, Layers I/II, APE/Lyrics3 trailers, audio decoding, and CRC validation.

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
npm run mutation           # Stryker decoder mutations, CI minimum 95%
```

`tests/` includes deterministic binary fixtures, structured property testing with fast-check, actual FFmpeg-encoded MP3s, HTTP injection tests, and a real TCP upload test. The mutation smoke harness is separate from the **coverage-guided Jazzer.js 4** targets. A raw-byte target detects crashes and chunk-dependent results; an independent structured-frame generator detects incorrect positive counts. Their seeds, regression corpus, minimizer, and limits are documented in [Fuzzing](fuzz/README.md).

For manual FFprobe comparison:

```bash
ffprobe -v error -select_streams a:0 -count_frames \
  -show_entries stream=nb_read_frames \
  -of default=noprint_wrappers=1:nokey=1 tests/fixtures/cbr.mp3
```

Because FFprobe reports decoder-facing frames, the expected output for the included sample is **32**, not 33. See [MP3 counting semantics](docs/architecture.md).

Optional HTTP load test with [k6](https://grafana.com/docs/k6/latest/):

```bash
npm run build && npm start
# In another terminal:
k6 run bench/upload.k6.js
```

## Developer workflow / security

- Node 24, native TypeScript 7 with the TypeScript 6 API compatibility alias, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM.
- ESLint + type-aware `typescript-eslint`, maintained Node security rules for application code, JS/MJS linting for build/fuzz/benchmark scripts, cyclomatic complexity warnings, and Prettier.
- Vitest/V8 coverage with enforced thresholds; fast-check properties; mutation smoke, Jazzer.js coverage-guided fuzzing, and replayable crash regressions.
- [Lefthook](https://lefthook.dev/) optional local hooks: `npm run hooks:install`. Pre-commit checks staged formatting and [Betterleaks](https://github.com/betterleaks/betterleaks) staged secrets (v1.9.0). Pre-push runs `npm run check`.
- GitHub Actions CI checks Node 24 and 26, a clean npm 11.9 installation, build/test/type/lint, focused mutation testing, bounded fuzzing, memory scaling, local HTTP measurements, complete and production dependency audits, workflow validation, Git-history secret scanning, focused Semgrep rules, and an unpacked release artifact. Weekly dependency audits catch newly published advisories.
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

See [Releasing and repository settings](docs/releasing.md) for the verified GitHub settings, what the current plan cannot enforce, permissions, artifact verification, provenance availability, and recovery of an interrupted release.

## More detail

- [Original assessment brief](docs/assessment-brief.md)
- [Frame-count contract: evidence and open question](docs/frame-count-contract.md)
- [Architecture, frame format and trade-offs](docs/architecture.md)
- [Testing, fuzzing, performance and reproduction](docs/testing.md)
- [Mutation review and equivalent mutants](docs/mutation-review.md)
- [Security assumptions and scope](docs/security.md)
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
The API returns `{"frameCount":6090}` using the documented **physical
MPEG-frame** counting contract. FFprobe and MediaInfo report **6089** because
the first MPEG frame carries only the Xing header; whether the assessment
expects 6089 is [an open question](docs/frame-count-contract.md).

The parser modules have **100% coverage** across statements, branches, functions
and lines using actual edge-case tests. The HTTP adapter retains defensive
branches without manufacturing test-only faults to obtain 100% overall coverage.
See [Testing](docs/testing.md) for mutation testing and security verification.
