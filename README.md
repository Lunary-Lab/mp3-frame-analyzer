# MP3 frame analyzer

A small, streaming TypeScript API that **logically counts MPEG-1 Audio Layer III frames**, without invoking an audio decoder or third-party MP3 parsing package.

## Quick start

Requirements: Node.js **24 LTS** and npm. Dependencies are locked in the committed `package-lock.json`; use `npm ci` for reproducible installation.

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

Exact error codes vary with validation failure. Error bodies are always JSON. Upload size is limited to **50 MiB** with one file part and no text fields; only a syntactically valid file yields a frame count.

## Why the frame count can differ from FFprobe

This endpoint counts **physical, complete MPEG-1 Layer III frames**. This includes a first MPEG frame containing Xing/Info/VBRI metadata. Such a frame may not carry independently decodable audio; some decoder-facing tools omit it from `nb_read_frames`. The included CBR and VBR fixtures contain 33 physical frames while `ffprobe -count_frames` reports 32 audio frames. The result is derived from frame headers **not** the Xing frame-count field.

This counting convention is explicit because the task asks for the number of frames _in the file_, not only the number of decoded audio packets. If a supplied evaluation sample defines decoded frames differently, the contract must be clarified; do not silently subtract one.

## Implementation

- `src/mp3/frame-header.ts`: pure MPEG-1 Layer III bit-field decoder and frame-size formula.
- `src/mp3/id3.ts`: ID3v2.2/2.3/2.4 synchsafe tag parsing; excludes ID3v1 tags.
- `src/mp3/byte-reader.ts`: incremental lookahead and skipping over any `AsyncIterable<Uint8Array>`.
- `src/mp3/count-frames.ts`: sequential frame traversal with no full-file buffering.
- `src/app.ts`: Fastify multipart route, response schemas, limits, and stable JSON errors.
- `src/server.ts`: configurable server bootstrap and graceful signal handling.

Complexity: **O(n)** time and **O(max upstream chunk size)** additional memory. Frame headers require only four bytes of lookahead, and metadata content is streamed past rather than accumulated.

The parser rejects invalid data at the next required frame boundary. It does not resynchronize after corrupt frames or arbitrarily skip noise before the first header: doing so can silently turn a malformed upload into a plausible but wrong count. It supports leading ID3v2 and trailing ID3v1 metadata. Unsupported scope includes MPEG-2/2.5, Layers I/II, APE/Lyrics3 trailers, compressed audio decoding, and CRC validation.

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
npm run test:memory        # builds first, then streams 100k frames (~40 MiB)
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
- ESLint + type-aware `typescript-eslint`, cyclomatic complexity warnings, Prettier.
- Vitest/V8 coverage with enforced thresholds; fast-check properties; mutation smoke, Jazzer.js coverage-guided fuzzing, and replayable crash regressions.
- [Lefthook](https://lefthook.dev/) optional local hooks: `npm run hooks:install`. Pre-commit checks staged formatting and [Betterleaks](https://github.com/betterleaks/betterleaks) staged secrets (v1.9.0). Pre-push runs `npm run check`.
- GitHub Actions CI runs build/test/type/lint, mutation smoke, bounded coverage-guided fuzzing, memory benchmark, production-dependency audit, actionlint workflow validation, Betterleaks Git-history scan, and focused Semgrep CE rules in `.semgrep.yml`.
- GitHub Actions are pinned to immutable commit SHAs; CI uses read-only repository permissions. Dependabot monitors npm and Actions dependencies.

The staged secrets hook needs Betterleaks installed locally; the hook fails closed if Betterleaks is unavailable **after you opt in**. Before submission, run `npm ci`, `npm run format:check`, and `npm run check` from a clean checkout. The application itself has no credentials, database, cloud dependencies, or deployment secrets. See [Security model](docs/security.md).

## More detail

- [Architecture, frame format and trade-offs](docs/architecture.md)
- [Testing, fuzzing, performance and reproduction](docs/testing.md)
- [Mutation review and equivalent mutants](docs/mutation-review.md)
- [Security assumptions and scope](docs/security.md)

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
The API correctly returns `{"frameCount":6090}` using the documented
**physical MPEG-frame** counting contract. FFprobe counts **6089 decoded audio
frames** because the first MPEG frame carries Xing metadata.

The parser modules have **100% coverage** across statements, branches, functions
and lines using actual edge-case tests. The HTTP adapter retains defensive
branches without manufacturing test-only faults to obtain 100% overall coverage.
See [Testing](docs/testing.md) for mutation testing and security verification.
