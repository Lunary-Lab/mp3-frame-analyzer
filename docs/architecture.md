# Architecture and decisions

## Boundary definition

`POST /file-upload` receives either one streamed multipart `file` or a raw binary `audio/mpeg` request body. Both use the same byte-stream parser. The HTTP adapter explicitly excludes one recognized initial encoder-metadata frame unless `includeVbrHeaderFrame=true` requests physical counting; omitted and `false` select exclusion. The upload module enforces upload resource limits, and the error-response module maps every failure to its JSON response. The parser itself knows nothing about HTTP or Fastify and accepts a standard `AsyncIterable<Uint8Array>`, so it is easy to unit-test with arbitrary chunk partitions. Direct `countMp3Frames()` calls retain their physical-frame default.

## MPEG-1 Layer III frame structure

A frame begins with a 32-bit header containing eleven sync bits, MPEG version, layer, CRC protection, bitrate index, sampling-rate index, and a padding bit. Bitrate indices 1..14 map to MPEG-1 Layer III rates from 32..320 kbps; sample-rate indices 0..2 map to 44,100 / 48,000 / 32,000 Hz.

For MPEG-1 Layer III, in bytes:

```
frameLength = floor(144000 * bitrateKbps / sampleRateHz) + padding
```

Every frame is parsed individually. This supports constant and variable bitrate streams. Audio payload bytes are skipped using the computed length, so MP3-like sync markers **inside** a frame never create false frames. CRC bytes are inside the declared frame and are not interpreted separately.

## Metadata and semantics

- Consecutive ID3v2 tags at each MPEG boundary are skipped by their **28-bit synchsafe size**, with matching v2.4 footers checked when present. Leading and embedded v2.2/2.3/2.4 tags are supported; a run after all audio requires a v2.4 footer on every tag. At most one final ID3v1 may follow. The former eight-tag restriction is removed; each iteration makes positive byte progress. HTTP byte limits and fixed inference lookahead are unchanged.
- Tag content and album art are never accumulated into whole-tag buffers. Outer lengths, flags and footers are validated; internal record semantics are not decoded.
- ID3v1 at the end is recognized by the `TAG` prefix and excluded from the count (the trailing tag must be exactly 128 bytes).
- The HTTP default excludes at most one structurally recognized **initial** Xing/Info or VBRI encoder-metadata frame. `includeVbrHeaderFrame=false` is explicit exclusion, and `true` returns all physical frames. LAME is an extension of Xing/Info, not an independent frame signature. No later frame is excluded, and files without a recognized initial header keep their full count. The parser traverses the file rather than copying an encoder-declared count. Its low-level default remains physical counting, while the HTTP adapter passes an explicit option. The owner approved the HTTP default; the evaluator's intended convention remains unconfirmed. See [the frame-count contract](frame-count-contract.md).
- The stream must start at a frame or an ID3v2 tag; arbitrary leading garbage is not scanned away. Invalid bytes at expected frame boundaries are rejected rather than silently resynchronized.
- Once indexed or free-format span is known, a truncated final frame, leftover partial header, or unrecognized trailing metadata is rejected. Initial short free-format inference has the explicit ambiguity limits below.

Free-format MPEG-1 Layer III uses bitrate index zero and a fixed unpadded span plus each frame's padding. One 8,647-byte search window evaluates bounded candidate spans, crossing validated tags only at each proposed boundary. One additional unsearched lookahead byte distinguishes its edge from actual EOF before a final ID3v1 tag can add boundary evidence. A validated tag header can anchor a body larger than the probe, which is subsequently streamed. Candidates are ranked by compatible MPEG headers and then metadata-boundary evidence; ties reject. Three-header chains remain supported; shorter chains require EOF or metadata anchoring and conservative compatible-header/plausible-metadata checks. This is structural inference, not proof of unique decoding: EOF cannot distinguish every complete singleton from a truncated or extended one. The [complete policy and source limitations](specifications/mpeg-1-layer-iii.md#4-free-format-layer-iii-bitrate-index-zero) are part of the contract. Locked traversal remains strict and never rescans payload.

This is a **structural parser**, not a full Layer III bitstream validator. Full Layer III validation would additionally examine side information, bit-reservoir usage, Huffman data and CRC integrity where present. Supporting additional tag families such as APEv2/Lyrics3, or other MPEG versions/layers, is a separate compatibility expansion—not part of those Layer III decoding checks and not added here.

## Resource model

The byte cursor queues incoming stream chunks to read a four-byte MPEG header or a ten-byte ID3 header, with one bounded ~8.7 KiB lookahead when inferring free-format frame spacing. Time is linear in bytes consumed; memory is proportional to the largest chunk delivered by the upstream stream, **not** the total upload size.

Fastify's multipart implementation provides stream backpressure, a configurable per-file cap (50 MiB by default via `MAX_UPLOAD_BYTES`), one file / one part limit, an 8 KiB multipart-header buffering bound, and dedicated error handling. Parsing terminates immediately on invalid headers. Request and idle-connection timeouts bound slow or abandoned uploads. These timeouts do not impose a global concurrency limit. A 50 MiB upload has a 30-second receive deadline, so filling the default maximum requires about 1.67 MiB/s before protocol overhead.

The upload module (`src/upload.ts`) applies media types, file limits, empty-upload checks and consumer cleanup. Raw failures and successful early returns close their connection after the response without draining. Multipart early success waits for the remainder and form validation; consumer rejection responds without awaiting its background drain. Rejected field-name/media-type parts still drain before their validation error is returned. A started consumer iterator is closed even if its caller omits cleanup; normal EOF already closes it. Cleanup failure after success propagates, while a secondary cleanup failure is logged without replacing the primary error. Custom consumers must await their reads; arbitrary detached consumer work cannot be cancelled by this API.

`src/multipart-budget.ts` counts the **complete transfer-decoded multipart HTTP body**, independently of Busboy's per-file limit. `MAX_MULTIPART_BYTES` / `buildApp({ maxMultipartBytes })` defaults to `min(MAX_UPLOAD_BYTES + 65536, Number.MAX_SAFE_INTEGER)`. The extra 64 KiB is project policy for framing, not an HTTP standard. Preamble, headers, ignored parts, epilogue and background-discarded bytes count. Oversized declared lengths reject before reading; a streaming crossing stops consumption and closes after the chosen response. If an earlier parser error already won, it remains the response. Reuse requires completion inside the budget and transport timeouts.

The pinned multipart plugin reads `request.raw`, so a Fastify `preParsing` payload transform would not enforce this boundary. The guard pauses the raw stream **before** registering its observer; starting multipart iteration then installs the plugin's pipe, which alone resumes normal reading/backpressure. No second drain or whole-body buffer is introduced. A crossing chunk may still reach Busboy because Node dispatches the current data-listener snapshot; a separate violation promise prevents accepting that operation. On overflow it keeps the pipe attached for normal EOF but re-pauses any downstream resume attempt until response closure. Unpiping immediately would strand the plugin when already-buffered HTTP input ends normally. The guard stays attached through raw body end/close, not merely file completion or an early error response, and removes its listeners then. This bounds application body consumption, not wire bytes or kernel/Node read-ahead, and does not decompress arbitrary Content-Encoding.

The route hands the module a consumer, the frame counter, and never touches request bodies itself ([ADR 0001](adr/0001-upload-module-owns-the-upload-lifecycle.md)).

An immediately ready in-memory async source can keep the parser busy until its input is consumed. The benchmark reports this delay honestly. Network backpressure and I/O provide natural scheduling points in the HTTP path; performance measurements include small requests alongside valid large uploads. If measurements under a real deployment show unfair scheduling, profile and add a bounded cooperative-yield policy before claiming a latency guarantee.

## Why no MPEG parser package or FFmpeg dependency?

The assignment explicitly requires deriving frame counts by parsing the MP3, without relying on an npm package that already performs frame parsing. The domain parser uses only TypeScript/standard Uint8Array operations. FFmpeg is used **only** to generate reproducible real-audio fixtures and independently compare results during development.

## References

- [MPEG frame header structure (MP3 frame reference)](https://www.mp3-tech.org/programmer/frame_header.html)
- [ID3v2.4 specification](https://id3.org/id3v2.4.0-structure)
- [Fastify multipart stream API](https://github.com/fastify/fastify-multipart)
