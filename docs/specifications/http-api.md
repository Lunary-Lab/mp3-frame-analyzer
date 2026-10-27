# HTTP transport and assessment API specification

**Primary contract:** [unaltered assignment](../assessment-brief.md). The RFCs describe HTTP/MIME encoding; they do **not** mandate this project's endpoint path, field name, upload cap, count convention or error JSON schema.

**Standards:** [RFC 3003 `audio/mpeg`](https://www.rfc-editor.org/rfc/rfc3003.html), [IANA media types registry](https://www.iana.org/assignments/media-types/), [RFC 7578 §4](https://www.rfc-editor.org/rfc/rfc7578.html), [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html), [RFC 8259 JSON](https://www.rfc-editor.org/rfc/rfc8259.html).

## Assessment-required interface

For a concise mandatory-versus-optional classification, see the [project interpretation appendix](../assessment-brief.md#appendix-project-interpretation-not-assignment-text).

- `POST /file-upload` must accept an MP3, parse **MPEG-1 Layer III** frames in TypeScript without a third-party MP3 frame parser package and reply `Content-Type: application/json` with exactly an integer count in a success object: `{"frameCount": N}`.
- Framework/multipart utility packages are allowed; generic media parsers for the implementation are **not**.
- Formats other than MPEG-1 Layer III are explicitly outside the exercise.
- The assignment does not prescribe multipart field name, MIME whitelist, raw-upload handling, optional query flags, strict corruption behavior, max upload size or error response JSON; these are documented application choices.

## Current endpoint contract (project-specific extensions)

Both uploads target the **same path**. Do not invent a second endpoint.

| Input path         | HTTP Content-Type                                             | Body                                              | Project behavior                          |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Standard multipart | `multipart/form-data; boundary=...`                           | One file part named `file`; no other fields/parts | Stream the bytes; enforce file size limit |
| Raw byte stream    | `audio/mpeg` (registered), plus allowed project aliases below | Direct MP3 bytes                                  | Stream the bytes; enforce same size limit |

Current MIME whitelist for raw _and file parts_: `audio/mpeg`, `audio/mp3`, `application/octet-stream`. **Only `audio/mpeg` is the registered MPEG audio type** under RFC 3003; `audio/mp3` is a compatibility alias (not listed as `audio/mp3` in IANA registry) and `application/octet-stream` is generic bytes. Accepted MIME and filename do not establish that bytes are MPEG-1 Layer III: inspect the contents. One rule applies to both. Normative: media types are case-insensitive (RFC 9110 §8.3.1), and only SP or HTAB is optional whitespace around one (RFC 9110 §5.6.3; RFC 7578 §4.4 gives form parts the RFC 2045 §5.1 `Content-Type` syntax). Project policy: parameters are ignored. So `Audio/MPEG ; x=1` is accepted, while a no-break space is not stripped and a quoted type such as `"audio/mpeg;"` is rejected.

RFC 7578 `4.1` mandates multipart boundary syntax and `4.2` mandates `Content-Disposition: form-data` with a `name` on each part. The spec does not require that the field be called `file`: that is our API policy. Ignore supplied filenames for paths or trust; filenames need not even be supplied by all conforming senders.

## Query policy and returned counts

`includeVbrHeaderFrame` (literal `true` or `false` only) controls whether to count a **recognized initial** Xing/Info or VBRI metadata-bearing MPEG frame. LAME data extends Xing/Info; it is not a separate frame signature:

- Omitted / `false` => exclude one recognized initial metadata frame (assessment sample **6089**).
- `true` => count all complete physical MPEG frames (sample **6090**).
- Files without a recognized initial metadata frame keep their full count under every option.
- Other query values => client error.
- Always determine physical frames by logical traversal, not the Xing header's declared count.

**The owner explicitly selected this HTTP default on 2026-10-24.** It is a breaking change from the previous physical-frame default. Direct `countMp3Frames()` calls retain their physical default because the HTTP adapter passes its policy explicitly. The evaluator confirmed audio-frame counting and **6089** for the sample on 2026-10-26, recommending MediaInfo as a sanity check; the existing default matches that clarification. This is structural metadata exclusion, not audio decoding. The decision and raw/multipart regressions are recorded in [frame-count-contract.md](../frame-count-contract.md).

## Success/error shape and classification

Success: JSON object `{"frameCount": number}`; `frameCount` is a nonnegative safe integer (accepted files require at least one physical frame before applying the selected initial-header policy). HTTP `200`.

Current application-generated errors: `{"error": string, "message": string}`, JSON `Content-Type`. Distinguish at least:

- 400: invalid upload structure or query value, missing `file`.
- 413: upload exceeds configured file size, aggregate multipart-body budget or multipart resource limits.
- 415: unsupported media type, recognized out-of-scope MPEG identifiers or unknown ID3 major version.
- 422: structurally invalid/truncated data, including reserved MPEG identifiers and forbidden ID3 version bytes.
- 503: upload admission exhausted (`server-busy`, `Retry-After: 1`, connection closes).
- 500: unexpected internal failure (sanitized client message).

These are **project mappings** compatible with RFC 9110 statuses, not exact error bodies mandated by the RFC. Admission rejects directly before body parsing; for errors raised while handling accepted requests, one pure function, `errorResponseFor` in [`src/error-response.ts`](../../src/error-response.ts), maps every failure the route raises to its status and body, and says whether the connection must close. The upload module also closes raw uploads it rejects, and a client that disconnected gets no response at all. An abandoned TCP connection or low-level timeout cannot always deliver a JSON reply.

### Supported, unsupported and malformed input

These are structural classifications, not an ISO conformance certificate or
proof of decoded-audio or CRC integrity. Both upload forms use the same parser;
direct calls report `Mp3ParseError` with `kind`, `message` and byte `offset`,
without an HTTP status.

| Observed input                                                                                                                    | Direct-parser classification / HTTP result                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete MPEG-1 Layer III indexed frames, or free-format with sufficient unambiguous bounded evidence                             | Count physical frames; HTTP 200 applies the selected initial-encoder-frame policy. Insufficient/ambiguous free-format inference is `unsupported-format` / 415, not proof of ISO-invalid audio. |
| Supported ID3v2.2/.3/.4 envelopes and placement                                                                                   | Skip metadata; ID3 records do not count as MPEG frames. Revisions 0-254 are accepted and tag content remains opaque.                                                                           |
| Nonreserved out-of-scope MPEG version/layer identifiers, or unknown ID3 major version without forbidden bytes                     | `unsupported-format` / 415.                                                                                                                                                                    |
| Bad sync, reserved MPEG version `01` or layer `00`, or forbidden bitrate/reserved rate or emphasis in MPEG-1 Layer III            | `invalid-mp3` / 422.                                                                                                                                                                           |
| ID3 major or revision byte `0xff`, reserved flags in a supported version, non-synchsafe size, or a complete mismatched footer     | `invalid-mp3` / 422.                                                                                                                                                                           |
| Incomplete recognized ID3 header/required footer, supported frame/tag body past EOF, or one to three bytes after a complete frame | `truncated-mp3` / 422, subject to the boundary precedence below.                                                                                                                               |
| Fewer than four initial MPEG bytes or only supported leading metadata                                                             | `invalid-mp3` / 422: no frames found. Empty HTTP uploads are rejected first as `empty-file` / 400.                                                                                             |
| Declared unsupported media type, including AAC/MP4                                                                                | Parser not invoked; `unsupported-media-type` / 415. Mislabeled AAC/MP4 fixtures with accepted MIME instead fail MPEG validation / 422.                                                         |

`unsupported-format` does **not** certify the rejected family. The parser stops
at nonreserved out-of-scope identifiers without validating that family's other
fields, frame geometry or payload; not every identifier combination is asserted
to be a defined codec. Unknown ID3 versions likewise are not asserted valid.
Unknown junk is not relabeled as a known codec, and APE/Lyrics3 remain unrecognized
optional tag families. There is no universal codec/container sniffer.

The [MPEG header reference](mpeg-1-layer-iii.md) describes the normative header
fields and the implementation's eleven-bit sync/two-bit version view. The
[ID3 author specifications](tags-and-encoder-headers.md#2-id3v2-header-sizes-and-version-differences)
forbid `0xff` in either version byte; that rule is distinct from an unknown major
version. Accepted MIME, filename or sync alone never establishes supported audio.

### First-observable-failure precedence and chunk invariance

Classification follows validated boundaries and the failure observable at that
point; it does not scan ahead to rank every possible error in the upload.

1. A complete four-byte MPEG header is required before classification. After a
   complete frame, one to three remaining bytes (even `ID3`) are a truncated
   trailing frame header before metadata dispatch. Bad sync and reserved
   version/layer identifiers are invalid before the other-family scope gate;
   other fields are validated only for MPEG-1 Layer III.
2. At a known ID3 boundary, fewer than ten header bytes are truncated even if an
   available byte is forbidden. Complete headers check forbidden version bytes
   first, then unknown major version, then supported-version flags and size.
   Unknown-major flags and body layouts are not interpreted.
3. Required header errors after indexed or locked free-format frames precede
   bitrate-mode mixing errors. Header-error offsets identify the header start;
   invalid synchsafe sizes identify the offending byte.
4. Bounded free-format candidate probes are not known frame boundaries. Their
   conservative inference/ambiguity policy can fail before a later candidate's
   metadata diagnostic; see the [inference profile](mpeg-1-layer-iii.md#4-free-format-layer-iii-bitrate-index-zero).
5. Transport errors, empty-upload checks and size-limit observation retain their
   precedence. A later upload-limit violation need not replace an already
   observed malformed-header error. Chunk partitioning does not alter parser
   classification or counting.

Exact diagnostics live with their implementations in
[`frame-header.ts`](../../src/mp3/frame-header.ts),
[`frame-spans.ts`](../../src/mp3/frame-spans.ts),
[`id3.ts`](../../src/mp3/id3.ts), [`count-frames.ts`](../../src/mp3/count-frames.ts)
and [`error-response.ts`](../../src/error-response.ts).
The [parser classification tests](../../tests/mp3/format-classification.test.ts)
and [HTTP classification tests](../../tests/mp3/format-classification-http.test.ts)
cover kinds, messages, offsets, raw/multipart status and chunk invariance.
[Unsupported-format tests](../../tests/mp3/unsupported-formats.test.ts) and their
[fixture manifest](../../tests/fixtures/unsupported-formats.json) distinguish
complete generated encodings from header-only rejection cases. Header-only
fixtures are not decoder-certified; decoded fixture counts establish provenance,
not a physical-count oracle.

## Resource/security policy (project, not MPEG/HTTP normative limits)

- `MAX_ACTIVE_UPLOADS` caps accepted upload lifetimes per server instance: default 8, configurable decimal integer 1–1024. No application queue; excess receives 503 before reading its body. Slots include upload-owned background work until settlement, plus response/transport completion. It is not a rate limiter, a fleet quota or a cap on idle connections.
- Per-file **50 MiB** default, configurable at server startup with `MAX_UPLOAD_BYTES` (positive safe integer in decimal bytes; invalid values fail before listening), enforced for **raw streams, chunked transfer without `Content-Length`, and multipart file parts**.
- One multipart part, one file, zero extra text fields; Busboy limits 32 header pairs and approximately 8 KiB for multipart header buffering.
- `MAX_MULTIPART_BYTES` independently caps the full transfer-decoded multipart body (preamble, headers, file, discarded parts and epilogue). Default: the file cap plus 64 KiB, saturated at the maximum safe integer; the same positive-decimal validation applies. This is application policy, not a standard-mandated allowance. Explicit lower caps are permitted.
- Declared or observed aggregate excess is `413 request-too-large` and closes the connection; a previously chosen response remains unchanged. Multipart reuse requires the entire body to finish inside this cap and transport timeouts. Raw early return/rejection closes without draining.
- Streaming retains backpressure and does not buffer whole uploads. Node may deliver the crossing chunk to the parser and transport buffers may read ahead; this is not a strict wire-byte cap or arbitrary Content-Encoding decompression limit. Public ingress still needs transport-level body caps, concurrency and rate limits.
- Early malformed files may receive an error before all upload bytes arrive. Ensure the rejected body drains/cancels in a bounded, connection-safe manner; do not retain unbounded background work.
- Do not write uploads to disk, execute uploaded data, shell out to FFmpeg, fetch remote metadata, or log binary payloads; the task's production parser is a self-contained TypeScript byte parser.

## Reproducible requests

```bash
# Multipart:
curl -i http://127.0.0.1:3000/file-upload \
  -F 'file=@tests/fixtures/cbr.mp3;type=audio/mpeg'

# Raw:
curl -i http://127.0.0.1:3000/file-upload \
  -H 'Content-Type: audio/mpeg' --data-binary @tests/fixtures/cbr.mp3

# Include all physical frames, including a recognized initial encoder header:
curl -i 'http://127.0.0.1:3000/file-upload?includeVbrHeaderFrame=true' \
  -F 'file=@tests/fixtures/vbr.mp3;type=audio/mpeg'
```

For binary transport, timeouts, upload limits and RFC handling tests, see [`upload.ts`](../../src/upload.ts), [`error-response.ts`](../../src/error-response.ts), [`app.ts`](../../src/app.ts), [HTTP E2E](../../tests/http.e2e.test.ts), [raw-upload tests](../../tests/raw-upload.test.ts) and [security tests](../../tests/security.test.ts).
