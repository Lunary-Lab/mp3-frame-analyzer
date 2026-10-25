# HTTP transport and assessment API specification

**Primary contract:** [unaltered assignment](../assessment-brief.md). The RFCs describe HTTP/MIME encoding; they do **not** mandate this project's endpoint path, field name, upload cap, count convention or error JSON schema.

**Standards:** [RFC 3003 `audio/mpeg`](https://www.rfc-editor.org/rfc/rfc3003.html), [IANA media types registry](https://www.iana.org/assignments/media-types/), [RFC 7578 §4](https://www.rfc-editor.org/rfc/rfc7578.html), [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html), [RFC 8259 JSON](https://www.rfc-editor.org/rfc/rfc8259.html).

## Assessment-required interface

For a concise mandatory-versus-optional classification, see [assessment-only scope](assessment-scope.md).

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

**The owner explicitly selected this HTTP default on 2026-10-24.** It is a breaking change from the previous physical-frame default. Direct `countMp3Frames()` calls retain their physical default because the HTTP adapter passes its policy explicitly. The choice matches MediaInfo's and FFprobe's **6089** result for the supplied sample, but the evaluator's intended convention remains inferred and unconfirmed. This is structural metadata exclusion, not audio decoding. The decision and raw/multipart regressions are recorded in [frame-count-contract.md](../frame-count-contract.md).

## Success/error shape and classification

Success: JSON object `{"frameCount": number}`; `frameCount` is a nonnegative safe integer (accepted files require at least one physical frame before applying the selected initial-header policy). HTTP `200`.

Current application-generated errors: `{"error": string, "message": string}`, JSON `Content-Type`. Distinguish at least:

- 400: invalid upload structure or query value, missing `file`.
- 413: upload exceeds configured file size or multipart resource limits.
- 415: unsupported media type or explicitly unsupported MPEG subtype.
- 422: structurally invalid/truncated MPEG data.
- 500: unexpected internal failure (sanitized client message).

These are **project mappings** compatible with RFC 9110 statuses, not exact error bodies mandated by the RFC. One pure function, `errorResponseFor` in [`src/error-response.ts`](../../src/error-response.ts), maps every failure the route raises to its status and body, and says whether the connection must close. The upload module also closes raw uploads it rejects, and a client that disconnected gets no response at all. An abandoned TCP connection or low-level timeout cannot always deliver a JSON reply.

## Resource/security policy (project, not MPEG/HTTP normative limits)

- Per-file **50 MiB** default, configurable at server startup with `MAX_UPLOAD_BYTES` (positive safe integer in decimal bytes; invalid values fail before listening), enforced for **raw streams, chunked transfer without `Content-Length`, and multipart file parts**.
- One multipart part, one file, zero extra text fields; Busboy limits 32 header pairs and approximately 8 KiB for multipart header buffering.
- Buffering/streaming must be **bounded**, using backpressure. An outer reverse proxy must apply any required aggregate HTTP body, concurrency and rate limits for public deployment; multipart per-file size is not an aggregate HTTP-body guarantee.
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
